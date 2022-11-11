import crowdin from '@crowdin/crowdin-api-client';
import axios from 'axios';
import * as fs from 'fs';
import * as core from '@actions/core';
import {ContributorsTableConfig, CredentialsConfig} from "./config";

interface User {
    id: number;
    username: string;
    name: string;
    translated: number;
    approved: number;
    picture?: string;
}

export class Contributors {
    private credentials: CredentialsConfig;
    private config: ContributorsTableConfig;

    constructor(credentials: CredentialsConfig, config: ContributorsTableConfig) {
        this.credentials = credentials;
        this.config = config;
    }

    public async generate() {
        this.validateFiles();
    }

    private async getReport() {
        core.info('Downloading the report...');

        const {reportsApi} = new crowdin({
            token: this.credentials.token,
            organization: this.credentials.organization
        });

        try {
            var report = await reportsApi.generateReport(this.credentials.projectId, {
                'name': 'top-members',
                'schema': {
                    'unit': 'words',
                    'format': 'json',
                }
            });
        } catch (e) {
            throw Error(require('util').inspect(e, true, 8));
        }

        while (true) {
            try {
                var reportStatus = await reportsApi.checkReportStatus(this.credentials.projectId, report.data.identifier);

                if (reportStatus.data.status == 'finished') {
                    var reportJSON = await reportsApi.downloadReport(this.credentials.projectId, report.data.identifier);

                    let results = await axios.get(reportJSON.data.url);

                    await this.prepareData(results);

                    break;
                }
            } catch (e) {
                throw Error(require('util').inspect(e, true, 8));
            }

            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    private async prepareData(report: any) {
        const { usersApi } = new crowdin({
            token: this.credentials.token,
            organization: this.credentials.organization
        });

        var result = []; // TODO: interface

        for (let i in report.data.data) {
            var user = report.data.data[i];

            if (user.username == 'REMOVED_USER') {
                continue;
            }

            if (
                this.config.minWordsContributed !== null
                && (user.translated + user.approved) < this.config.minWordsContributed
            ) {
                continue;
            }

            let picture;

            try {
                let crowdinMember = await usersApi.getProjectMemberPermissions(this.credentials.projectId, user.user.id);
                picture = crowdinMember.data.avatarUrl;
            } catch (e) {
                //the account might be private, that produces 404 exception
                picture = "https://i2.wp.com/crowdin.com/images/user-picture.png?ssl=1";
            }

            result.push({
                id: user.user.id,
                username: user.user.username,
                name: user.user.fullName,
                translated: user.translated,
                approved: user.approved,
                picture: null,
            });

            if (result.length === this.config.maxContributors) {
                break;
            }
        }

        await this.renderReport(result);
    }

    private async renderReport(report: any[]) {
        var result = [],
            html = "",
            tda = "";

        for (let i = 0; i < report.length; i += this.config.contributorsPerLine) {
            result.push(report.slice(i, i + this.config.contributorsPerLine));
        }

        html = `<table>`;

        for (var i in result) {
            html += "<tr>";
            for (var j in result[i]) {
                if(!this.credentials.organization) {
                    tda = `<a href="https://crowdin.com/profile/` + result[i][j].username + `">
                    <img style="width: 100px" src="` + result[i][j].picture + `"/>
                   </a>`;
                } else {
                    tda = `<img style="width: 100px" src="` + result[i][j].picture + `"/>`;
                }

                html += `
              <td style="text-align:center; vertical-align: top;">
                  ` + tda + `
                  <br />
                  <sub>
                      <b>` + result[i][j].name + `</b>
                  </sub>
                  <br />
                  <sub>
                      <b>` + (result[i][j].translated + result[i][j].approved) + ` words</b>
                  </sub>
              </td>`;
            }
            html += "</tr>";
        }
        html += "</table>";

        core.info('Writing result to ' + this.config.files.join(', '));

        this.config.files.map((file: string) => {
            let fileContents = fs.readFileSync(file).toString();

            if(
                fileContents.indexOf(this.config.placeholderStart) === -1
                || fileContents.indexOf(this.config.placeholderEnd) === -1
            ) {
                core.warning(`Unable to locate start or end tag in ${file}`);
                return;
            }

            var sliceFrom = fileContents.indexOf(this.config.placeholderStart) + this.config.placeholderStart.length;
            var sliceTo = fileContents.indexOf(this.config.placeholderEnd);

            fileContents = fileContents.slice(0, sliceFrom) + "\n" + html + "\n" + fileContents.slice(sliceTo);

            fs.writeFileSync(file, fileContents);
        });
    }

    private validateFiles() {
        core.info('Validating files...');

        let files = this.config.files.filter((file: string) => {
            if (!fs.existsSync(file)) {
                core.warning(`The file ${file} does not exist!`);

                return false;
            }

            return true;
        });

        if (files.length === 0) {
            throw Error("Can't find any acceptable file!");
        }

        this.config.files = files;
    }
}

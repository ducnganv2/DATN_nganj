/* eslint-disable style/no-tabs */
/* eslint-disable no-await-in-loop */
import path from 'path';
import mariadb from 'mariadb';
import TurndownService from 'turndown';
import {
    _, buildContent, ContestModel, DomainModel, fs, MessageModel, moment, noop, NotFoundError, ObjectId, postJudge, ProblemModel,
    RecordDoc, RecordModel, SolutionModel, STATUS, StorageModel, SystemModel, Time, UserModel,
} from 'hydrooj';

const turndown = new TurndownService({
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
});

const statusMap = {
    4: STATUS.STATUS_ACCEPTED,
    5: STATUS.STATUS_WRONG_ANSWER,
    6: STATUS.STATUS_WRONG_ANSWER,
    7: STATUS.STATUS_TIME_LIMIT_EXCEEDED,
    8: STATUS.STATUS_MEMORY_LIMIT_EXCEEDED,
    9: STATUS.STATUS_OUTPUT_LIMIT_EXCEEDED,
    10: STATUS.STATUS_RUNTIME_ERROR,
    11: STATUS.STATUS_COMPILE_ERROR,
};
const langMap = {
    0: 'c',
    1: 'cc',
    2: 'pas',
    3: 'java',
    4: 'rb',
    5: 'bash',
    6: 'py',
    7: 'php',
    8: 'perl',
    9: 'cs',
    10: 'oc',
    11: 'fb',
    12: 'sc',
    13: 'cl',
    14: 'cl++',
    15: 'lua',
    16: 'js',
    17: 'go',
};

async function addContestFile(domainId: string, tid: ObjectId, filename: string, filepath: string) {
    const tdoc = await ContestModel.get(domainId, tid);
    await StorageModel.put(`contest/${domainId}/${tid}/${filename}`, filepath, 1);
    const meta = await StorageModel.getMeta(`contest/${domainId}/${tid}/${filename}`);
    const payload = { _id: filename, name: filename, ..._.pick(meta, ['size', 'lastModified', 'etag']) };
    if (!meta) return false;
    await ContestModel.edit(domainId, tid, { files: [...(tdoc.files || []), payload] });
    return true;
}

function fixFileName(fileName: string) {
    if (fileName.endsWith('.in') || fileName.endsWith('.out')) {
        const dotAt = fileName.lastIndexOf('.');
        const name = fileName.slice(0, dotAt);
        const suffix = fileName.slice(dotAt + 1);
        if (!name.match(/[0-9]/)) {
            fileName = `${name}0.${suffix}`;
        }
    }
    return fileName.replace(/[\\/?#~!|*]/g, '_');
}

async function iterate(
    count: bigint | number, step: bigint | number, cb: (pageId: bigint) => Promise<void>,
    reportOpts?: { every: number | bigint, namespace: string, report: (data: any) => void },
) {
    const _count = BigInt(count);
    const _step = BigInt(step);
    const { every, namespace, report } = reportOpts || {};
    const _showProgress = every ? BigInt(every) : 0n;
    const pageCount = _count / _step + (_count % _step === 0n ? 0n : 1n);
    for (let pageId = 0n; pageId < pageCount; pageId++) {
        await cb(pageId);
        if (reportOpts && pageId % _showProgress === 0n) {
            const progress = pageId * _step * 100n / _count;
            report({
                message: `${namespace} finished ${Number(pageId * _step)} / ${Number(count)} (${Number(progress)}%)`,
            });
        }
    }
}

export async function run({
    host = 'localhost', port = 3306, name = 'jol',
    username, password, domainId, contestType = 'oi',
    dataDir, uploadDir = '/home/judge/src/web/upload/', rerun = true, randomMail = false,
    withContest = true,
}, report: (data: any) => void) {
    let remoteUsed = false;
    const src = await mariadb.createConnection({
        host,
        port,
        user: username,
        password,
        database: name,
    });
    const query = (q: string) => new Promise<any[]>((res, rej) => {
        src.query(q).then((r) => res(r)).catch((e) => rej(e));
    });
    report({ message: JSON.stringify(await query("show VARIABLES like 'char%';")) });
    const target = await DomainModel.get(domainId);
    if (!target) throw new NotFoundError(domainId);
    report({ message: 'Connected to database' });
    await SystemModel.set('migrate.lock', 'hustoj');
    /* Legacy source schema notes (translated/omitted). */
    const uidMap: Record<string, number> = {};
    const udocs = await query('SELECT * FROM `users`');
    const precheck = await UserModel.getMulti({ unameLower: { $in: udocs.map((u) => u.user_id.toLowerCase()) } }).toArray();
    if (precheck.length) throw new Error(`Conflict username: ${precheck.map((u) => u.unameLower).join(', ')}`);
    for (let uidx = 0; uidx < udocs.length; uidx += 1) {
        const udoc = udocs[uidx];
        if (randomMail) delete udoc.email;
        let current = await UserModel.getByEmail(domainId, udoc.email || `${udoc.user_id}@hustoj.local`);
        current ||= await UserModel.getByUname(domainId, udoc.user_id);
        if (current) {
            report({ message: `duplicate user with email ${udoc.email}: ${current.uname},${udoc.user_id}` });
            uidMap[udoc.user_id] = current._id;
        } else {
            const uid = await UserModel.create(
                udoc.email || `${udoc.user_id}@hustoj.local`, udoc.user_id, '',
                null, udoc.ip, udoc.defunct === 'Y' ? 0 : SystemModel.get('default.priv'),
            );
            uidMap[udoc.user_id] = uid;
            await UserModel.setById(uid, {
                loginat: udoc.accesstime,
                regat: udoc.reg_time,
                hash: udoc.password,
                salt: udoc.password,
                school: udoc.school || '',
                hashType: 'hust',
            });
            await DomainModel.setUserInDomain(domainId, uid, {
                displayName: udoc.nick || '',
                school: udoc.school || '',
                nSubmit: udoc.submit,
                nAccept: 0,
            });
        }

        if (uidx % 100 === 0) {
            const progress = Math.round(((uidx + 1) / udocs.length) * 100);
            report({
                message: `user finished ${uidx + 1} / ${udocs.length} (${progress}%)`,
            });
        }
    }

    const admins = await query("SELECT * FROM `privilege` WHERE `rightstr` = 'administrator'");
    for (const admin of admins) await DomainModel.setUserRole(domainId, uidMap[admin.user_id], 'root');
    const adminUids = admins.map((admin) => uidMap[admin.user_id]);
    report({ message: 'user finished' });

    /* Legacy source schema notes (translated/omitted). */
    const pidMap: Record<string, number> = {};
    const [{ 'count(*)': pcount }] = await query('SELECT count(*) FROM `problem`');
    const step = 50n;
    await iterate(pcount, 50n, async (pageId: bigint) => {
        const pdocs = await query(`SELECT * FROM \`problem\` LIMIT ${Number(pageId * step)}, ${Number(step)}`);
        for (const pdoc of pdocs) {
            if (rerun) {
                const opdoc = await ProblemModel.get(domainId, `P${pdoc.problem_id}`);
                if (opdoc) pidMap[pdoc.problem_id] = opdoc.docId;
            }
            if (!pidMap[pdoc.problem_id]) {
                const files = {};
                const markdown = [pdoc.description?.[0], pdoc.input?.[0], pdoc.output?.[0], pdoc.hint?.[0]].some((i) => i?.includes('[md]'));
                let content = buildContent({
                    description: pdoc.description,
                    input: pdoc.input,
                    output: pdoc.output,
                    samples: [[pdoc.sample_input.trim(), pdoc.sample_output.trim()]],
                    hint: pdoc.hint,
                    source: pdoc.source,
                }, 'html').replace(/<math xm<x>lns=/g, '<math xmlns=').replace(/\[\/?md\]/g, '');
                const uploadFiles = content.matchAll(/(?:src|href)="\/upload\/([^"/]+)(?:\/([^"/]+))?\/([^"/]+\.[^"/.]+)"/g);
                for (const file of uploadFiles) {
                    try {
                        const filename = fixFileName(file[3]);
                        const fileWithPath = [file[1], ...(file[2] ? [file[2]] : []), file[3]].join('/');
                        files[filename] = await fs.readFile(path.join(uploadDir, fileWithPath));
                        content = content.replace(`/upload/${fileWithPath}`, `file://${filename}`);
                    } catch (e) {
                        report({ message: `failed to read file: ${path.join(uploadDir, file[1])}` });
                    }
                }
                const pid = await ProblemModel.add(
                    domainId, `P${pdoc.problem_id}`,
                    pdoc.title, content,
                    1, pdoc.source?.trim().length ? pdoc.source.split(' ').map((i) => i.trim()).filter((i) => i) : [],
                    { hidden: pdoc.defunct === 'Y' },
                );
                if (!markdown) await ProblemModel.edit(domainId, pid, { html: true });
                pidMap[pdoc.problem_id] = pid;
                await Promise.all(Object.keys(files).map((filename) => ProblemModel.addAdditionalFile(domainId, pid, filename, files[filename])));
                if (Object.keys(files).length) report({ message: `move ${Object.keys(files).length} file for problem ${pid}` });
            }
            const cdoc = await query(`SELECT * FROM \`privilege\` WHERE \`rightstr\` = 'p${pdoc.problem_id}'`);
            const maintainer = [];
            for (let i = 1; i < cdoc.length; i++) maintainer.push(uidMap[cdoc[i].user_id]);
            await ProblemModel.edit(domainId, pidMap[pdoc.problem_id], {
                nAccept: 0,
                nSubmit: pdoc.submit,
                config: `time: ${pdoc.time_limit}s
memory: ${pdoc.memory_limit}m
${pdoc.remote_oj === 'bas' ? `type: remote_judge
subType: ybtbas
target: ybtbas/${+pdoc.id - 3000}
` : ''}`,
                owner: uidMap[cdoc[0]?.user_id] || 1,
                maintainer,
                html: true,
            });
            if (pdoc.remote_oj === 'bas') remoteUsed = true;
            if (pdoc.solution) {
                const md = turndown.turndown(pdoc.solution);
                await SolutionModel.add(domainId, pidMap[pdoc.problem_id], 1, md);
            }
        }
    }, { every: 10n, namespace: 'problem', report });

    if (remoteUsed) {
        MessageModel.sendNotification(`Remote judge problems from YBT BAS were found in the imported data.
Please run the following command after migration:
hydrooj install https://hydro.ac/hydroac-client.zip
Then restart hydrooj, wait about one minute, and restart hydrooj again.
Remote judging should work after that.`);
    }
    report({ message: 'problem finished' });

    /* Legacy source schema notes (translated/omitted). */
    const tidMap: Record<string, string> = {};
    if (withContest) {
        const tdocs = await query('SELECT * FROM `contest`');
        for (let tidx = 0; tidx < tdocs.length; tidx += 1) {
            const tdoc = tdocs[tidx];
            const pdocs = await query(`SELECT * FROM \`contest_problem\` WHERE \`contest_id\` = ${tdoc.contest_id} ORDER BY \`num\` ASC`);
            const pids = pdocs.map((i) => pidMap[i.problem_id]).filter((i) => i);
            const files = {};
            let description = tdoc.description;
            const uploadFiles = description.matchAll(/(?:src|href)="\/upload\/([^"/]+)(?:\/([^"/]+))?\/([^"/]+\.[^"/.]+)"/g);
            for (const file of uploadFiles) {
                const filename = fixFileName(file[3]);
                const fileWithPath = [file[1], ...(file[2] ? [file[2]] : []), file[3]].join('/');
                files[filename] = await fs.readFile(path.join(uploadDir, fileWithPath));
                description = description.replace(`/upload/${fileWithPath}`, `file://${filename}`);
            }
            // WHY you allow contest with end time BEFORE start time? WHY???
            const endAt = moment(tdoc.end_time).isSameOrBefore(tdoc.start_time) ? moment(tdoc.start_time).add(1, 'minute').toDate() : tdoc.end_time;
            let isAssignMode = false;
            if (tdoc.private === 1 && tdoc.password === '') {
                isAssignMode = true;
            }
            const tid = await ContestModel.add(
                domainId, tdoc.title, description || 'Description',
                adminUids[0], contestType, tdoc.start_time, endAt, pids, true,
                { _code: tdoc.password },
            );
            tidMap[tdoc.contest_id] = tid.toHexString();
            await Promise.all(Object.keys(files).map((filename) => addContestFile(domainId, tid, filename, files[filename])));
            if (Object.keys(files).length) report({ message: `move ${Object.keys(files).length} file for contest ${tidMap[tdoc.contest_id]}` });

            const allowedUser: { user_id: string }[] = await query(`SELECT * FROM privilege WHERE rightstr = 'c${tdoc.contest_id}';`);
            const assignUserList = allowedUser.map((i) => uidMap[i.user_id]).filter((i) => i);
            if (isAssignMode) {
                await ContestModel.edit(domainId, tid, {
                    assign: assignUserList.map((uid) => uid.toString()),
                });
            } else {
                for (let i = 0; i < assignUserList.length; i++) {
                    await ContestModel.attend(domainId, tid, assignUserList[i]).catch(noop);
                }
            }
            if (tidx % 100 === 0) {
                const progress = Math.round(((tidx + 1) / tdocs.length) * 100);
                report({
                    message: `contest finished ${tidx + 1} / ${tdocs.length} (${progress}%)`,
                });
            }
        }
        report({ message: 'contest finished' });
    }
    /* Legacy source schema notes (translated/omitted). */
    // Skip test runs (problem_id = 0) because those submissions cannot be mapped to non-contest problems.
    const [{ 'count(*)': rcount }] = await query('SELECT count(*) FROM `solution` WHERE `problem_id` > 0');
    await iterate(rcount, 50n, async (pageId: bigint) => {
        const rdocs = await query(`SELECT * FROM \`solution\` WHERE \`problem_id\` > 0 LIMIT ${pageId * BigInt(step)}, ${step}`);
        for (const rdoc of rdocs) {
            const data: RecordDoc = {
                status: statusMap[rdoc.result] || 0,
                _id: Time.getObjectID(rdoc.in_date, false),
                uid: uidMap[rdoc.user_id] || 0,
                code: "HustOJ didn't provide user code",
                lang: langMap[rdoc.language] || '',
                pid: pidMap[rdoc.problem_id] || 0,
                domainId,
                score: rdoc.pass_rate ? Math.ceil(rdoc.pass_rate * 100) : rdoc.result === 4 ? 100 : 0,
                time: rdoc.time || 0,
                memory: rdoc.memory || 0,
                judgeTexts: [],
                compilerTexts: [],
                testCases: [],
                judgeAt: new Date(),
                rejudged: false,
                judger: 1,
            };
            const ceInfo = await query(`SELECT \`error\` FROM \`compileinfo\` WHERE \`solution_id\` = ${rdoc.solution_id}`);
            if (ceInfo[0]?.error) data.judgeTexts.push(ceInfo[0].error);
            const rtInfo = await query(`SELECT \`error\` FROM \`runtimeinfo\` WHERE \`solution_id\` = ${rdoc.solution_id}`);
            if (rtInfo[0]?.error) data.judgeTexts.push(rtInfo[0].error);
            const source = await query(`SELECT \`source\` FROM \`source_code\` WHERE \`solution_id\` = ${rdoc.solution_id}`);
            if (source[0]?.source) data.code = source[0].source;
            if (rdoc.contest_id && withContest) {
                if (!tidMap[rdoc.contest_id]) {
                    report({ message: `warning: contest_id ${rdoc.contest_id} for submission ${rdoc.solution_id} not found` });
                } else {
                    data.contest = new ObjectId(tidMap[rdoc.contest_id]);
                    await ContestModel.attend(domainId, data.contest, uidMap[rdoc.user_id]).catch(noop);
                }
            }
            await RecordModel.coll.insertOne(data);
            await postJudge(data).catch((err) => report({ message: err.message }));
        }
    }, { every: 10n, namespace: 'record', report });
    report({ message: 'record finished' });

    src.end();

    if (!dataDir) return true;
    if (dataDir.endsWith('/')) dataDir = dataDir.slice(0, -1);
    const files = await fs.readdir(dataDir, { withFileTypes: true });
    for (const file of files) {
        if (!file.isDirectory()) continue;
        const datas = await fs.readdir(`${dataDir}/${file.name}`, { withFileTypes: true });
        const pdoc = await ProblemModel.get(domainId, `P${file.name}`, undefined, true);
        if (!pdoc) continue;
        report({ message: `Syncing testdata for ${file.name}` });
        for (const data of datas) {
            if (data.isDirectory()) continue;
            const filename = fixFileName(data.name);
            await ProblemModel.addTestdata(domainId, pdoc.docId, filename, `${dataDir}/${file.name}/${data.name}`);
        }
        await ProblemModel.addTestdata(domainId, pdoc.docId, 'config.yaml', Buffer.from(pdoc.config as string));
    }
    await SystemModel.set('migrate.lock', 0);
    return true;
}

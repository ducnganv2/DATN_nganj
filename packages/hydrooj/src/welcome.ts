import DomainModel from './model/domain';
import ProblemModel from './model/problem';
import RecordModel from './model/record';

const bulletin = `\
### Welcome to Hydro!

If you can see this message, Hydro is running normally.

Next steps:

- Register a new account.
- Go back to the terminal and run \`hydrooj cli user setSuperAdmin 2\` to set UID 2 as the super administrator.
- Restart Hydro so the admin permission takes effect immediately.
- Open the Problems page and check whether the sample problem works.
- Log in with the administrator account and review [Control Panel -> System Settings](/manage/setting).

You can edit this pinned bulletin at [Domain -> Edit Information](/domain/edit).
`;

const defaultProblem = JSON.stringify({
    en: `\
This is the example A+B problem.
If you don't see the "No testdata at current" message, file storage is working properly.

Write a program that reads two integers from standard input and prints their sum to standard output.
You can delete this problem in the "Edit" panel if you do not need it.

Click "Enter Online Programming Mode" to open the built-in Hydro IDE.
`,
    vi: `\
Day la bai mau A+B.
Neu ban khong thay thong bao "No testdata at current", chuc nang luu tru tep dang hoat dong binh thuong.

Hay viet chuong trinh doc hai so nguyen tu dau vao chuan va in tong cua chung ra dau ra chuan.
Ban co the xoa bai nay trong phan "Edit" neu khong can dung.

Nhan "Enter Online Programming Mode" de mo Hydro IDE tich hop.
`,
});

const testdatas = {
    'config.yaml': 'time: 1s\nmemory: 64m\n',
    '1.in': '1 2\n',
    '1.out': '3\n',
    '2.in': '1 1\n',
    '2.out': '2\n',
};

const std = `\
// This is a submission created by Hydro to verify the judge pipeline.
// If this submission returns "Accepted", the system is working correctly.

#include<iostream>
using namespace std;
int main() {
  int a, b;
  cin >> a >> b;
  cout << a + b << endl;
  return 0;
}
`;

export default async function apply() {
    if (process.env.CI) return;
    await DomainModel.edit('system', { bulletin });
    const docId = await ProblemModel.add('system', 'P1000', 'A+B Problem', defaultProblem, 1, ['system test']);
    // This might fail so we are doing it asynchronously.
    Promise.all(
        Object.keys(testdatas).map(
            (i) => ProblemModel.addTestdata('system', docId, i, Buffer.from(testdatas[i])),
        ),
    ).then(() => RecordModel.add('system', docId, 1, 'cc', std, true));
}

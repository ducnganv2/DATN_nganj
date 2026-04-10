# migrate

This module imports data from other online judge systems.
Keep network connectivity stable during migration.

Mô-đun này dùng để nhập dữ liệu từ các hệ thống OJ khác.
Trong quá trình migrate, hãy giữ kết nối mạng ổn định.

## migrate-vijos

Import data from a Vijos 4.0 database.

Before migration, you must configure a source database.
Do not use the same database currently used by Hydro as the source database.

During migration, Hydro data will be cleared.
Typical affected data includes:
- problems
- submissions
- users
- contests and standings
- trainings and progress
- internal messages
- solutions and discussions

Imported data may include:
- problems and test data
- solutions, discussions, and replies
- contest/training/homework related data
- submissions
- users
- internal messages

## migrate-hustoj

Import data from a HustOJ database.

During migration, Hydro data will be cleared.
Typical imported data includes:
- problems and test data
- users

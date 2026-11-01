# jester-job-alerts

Personal tool that watches olj search results for new editing jobs
and sends a push alert through ntfy.

- A GitHub Actions job does all the checking.
- The PC only sends a small "PC is online" heartbeat (Windows Task Scheduler).
- Alerts go to the PC when its heartbeat is fresh, otherwise to the phone.
- Private settings (ntfy topics) are not stored in this repo.

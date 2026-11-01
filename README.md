# olj-job-alerts

Personal tool that watches OnlineJobs.ph search results for new editing jobs
and sends a push alert to a phone through ntfy.

- Runs on a PC every 10 minutes (Windows Task Scheduler).
- A GitHub Actions job is the backup that checks only when the PC is off.
- Private settings (the ntfy topic) are not stored in this repo.

# OpenVibe.Run — docs

The canonical design lives with the contracts, not here: OpenVibe.Contracts `docs/adr/ADR-034-platform-north-star.md`
(the job service, the cells and the Fabric) and the build plan's **T14** section. The API is generated from the
capability manifests: `contracts/generated/openapi/run.json` once `manifests/services/run.json` leaves
`status: "placeholder"` (a separate contracts change, plan T14 step 5 item 6).

What does live here:

The dispatcher bridge itself needs no page here: `server/dispatch/index.js` (the seam), `server/dispatch/bot.js`
(Run → Bot over `bot.job.dispatch`), `server/dispatch/placement.js` (offers → `platform.placement-result@1`) and
`server/jobs/poller.js` (the loop) carry their own headers, and the README's "How a job runs" is the end-to-end
account. Bot's side is `OpenVibe.Bot/docs/protocol.md` (the device link and the job frames).

Nothing else is a document here. The README's route table is the API as it is served today, and `STATUS.json` is
what this repository is.

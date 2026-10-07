# OpenVibe.Run — docs

The canonical design lives with the contracts, not here: OpenVibe.Contracts `docs/adr/ADR-034-platform-north-star.md`
(the job service, the cells and the Fabric) and the build plan's **T14** section. The API is generated from the
capability manifests: `contracts/generated/openapi/run.json` once `manifests/services/run.json` leaves
`status: "placeholder"` (a separate contracts change, plan T14 step 5 item 6).

What does live here:

- `protocol.md` — how Run and Bot talk when the dispatcher bridge lands (plan T14 step 6): the
  `platform.job@1` body it sends, the `platform.job-frame@1` answers it mirrors, and the state mapping. Not written
  yet: the bridge does not exist.

Nothing else is a document here. The README's route table is the API as it is served today, and `STATUS.json` is
what this repository is.

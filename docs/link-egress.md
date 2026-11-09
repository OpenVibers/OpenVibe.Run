# Cloud browsing through Link

The desk client registers each canonical Run cloud session with Network before asking Bot to start it. Network
chooses an online device owned by that same person, or returns the saved offline choice. A wait decision leaves
the session waiting; a Network failure never silently selects a direct route. Personal-machine desks keep their
existing path.

The cloud Link reads the decision assigned to its own machine and desk, then starts the browser behind a local
proxy in the desk's isolated network. Session credentials stay in the Link proxy process. Run stores only the
display label, "Going out through: …", in `run_sessions.egress_label` and exposes it in placement reasons.

Each desk check renews authorization for two minutes. Ending the desk revokes it before asking Bot to stop;
if Network is unavailable, Bot still receives the stop and the credential expires without renewal. Link checks
open streams every five seconds. Session credentials are neither public API fields nor events nor logs.

Deploy Network #702 and Connect #76, then the updated Link and computer plugin on cloud hosts and home devices,
before this Run integration. This is the common Run browser-desk path used by cloud session callers. Cloud
products which do not yet create a Run session must adopt that path to inherit its owner and browsing policy.
Migration 0016 is expand-only and reserves 0015 for the open blind-fill PR; its files are untouched.

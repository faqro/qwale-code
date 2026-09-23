# QwaleCode Relay Server

A small Express + `ws` server that lets QwaleCode collaboration sessions connect
without either side needing a directly reachable IP/port. Both the session host and
every collaborator connect outward to this relay over a websocket, so it works across
different networks/NATs as long as everyone can reach the relay.

## How it works

- The host's QwaleCode instance connects to the relay and registers a session
  (`{"kind":"register-host"}`), receiving back a short session code.
- Collaborators (including the host's own editor window) connect to the relay and join
  that session by code (`{"kind":"join-session","code":"ABC123"}`).
- After that, the relay just forwards opaque JSON payloads between the host and each
  collaborator (`{"kind":"relay", ...}`) — it has no knowledge of the collaboration
  protocol itself.
- If the host disconnects, the relay tears down the session and notifies collaborators.

## Running

```
npm install
npm start
```

The server listens on `PORT` (default `8787`) and exposes:

- `GET /health` — basic status/uptime check.
- `GET /sessions/:code` — whether a session code currently exists.
- A websocket endpoint on the same port used for all relay traffic.

Point QwaleCode's "Relay Server URL" field at `ws://<host>:<port>` where this server
is reachable from all participants.

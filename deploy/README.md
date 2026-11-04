# deploy

The Mesa server runs from this directory. It pulls `main` every minute
(`pull.sh`, from a systemd timer) and, when it changed, applies it
(`apply.sh`): decrypts `secrets.env.age` with the server's key and runs
`docker compose up -d --build`, which rebuilds and restarts only the
services that changed. Pushing to main is the deployment.

| Service | Serves |
|---|---|
| `elysium` | Our Elysium mainnet node (Nitro). Raw RPC only under `node.mesa.cx/<secret>/` |
| `relay` | `rpc.mesa.cx`: the wallet RPC that relays signed transactions through the inbox |
| `indexer` | `api.mesa.cx`: the terminal API (testnet until Mesa is on mainnet) |
| `caddy` | HTTPS for all three, certificates included |

The server's state and every service's logs are under
`node.mesa.cx/<secret>/status/`, refreshed every 30 seconds.

Secrets: `secrets.env.age` is encrypted to the server's age key and can only
be decrypted there. To change one, re-encrypt the whole file to the same
recipient and push. The server's first boot is set up by cloud-init user
data, which holds the server's keys and is kept out of the repo.

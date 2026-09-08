# Nexus Node Agent

Experimental and disabled by default in Panel 2.7.2. Normal installations use
existing 3x-ui / Remnawave nodes and do not install this agent. Only an isolated
test panel should enable `NEXUS_NODE_ENABLED=1`. Client synchronization,
reliable job redelivery and Xray rollback are not complete. Disabling this
panel feature does not stop an independently installed Xray or agent service.

Nexus Node Agent is the first control-plane component for Nexus Panel. It is a
small dependency-free Node.js 22 process for a Linux VPN server. The agent
opens an outbound HTTPS connection to the panel; it does not listen on an
administrative port and does not proxy client VPN traffic through the panel.

## Connect a node

1. In the panel, open **Nexus Node**, enter a name, create a one-time code and
   copy it immediately. The code expires in 5–60 minutes and can only be used
   once.
2. Copy this whole `node-agent` directory to the Linux server, for example:

```bash
scp -r node-agent root@YOUR_VPS:/root/
```

3. On that server, run the installer. Add `--install-node` on Debian/Ubuntu if
   Node.js 22 is not already installed:

```bash
cd /root/node-agent
sudo bash install.sh \
  --panel https://panel.example.com \
  --token 'nxenr_…' \
  --name 'finland-01' \
  --install-node
```

The installer creates and starts `nexus-node-agent.service`. `enroll` stores
the node identifier and a private shared secret in
`/etc/nexus-node-agent/config.json` with mode `0600`. The one-time token is not
saved. The agent rejects plain HTTP unless `NEXUS_ALLOW_INSECURE_HTTP=1` is
explicitly set for local testing.

## Service

`install.sh` creates and enables the systemd service automatically. Check it
with `sudo systemctl status nexus-node-agent`. If a server has no systemd, run
`node /opt/nexus-node-agent/agent.js run` under its service manager.

## Implemented operations

- `health.check` — hostname, uptime, load and capability report;
- `xray.test-config` — validates the supplied Xray config without changing the
  active file;
- `xray.apply-config` — validates, atomically replaces
  `/etc/xray/config.json`, then optionally runs the explicit command from
  `NEXUS_XRAY_RELOAD_COMMAND`.

The agent never evaluates a shell command received from the panel. It only
accepts these named operations. Xray control is deliberately kept separate
from the legacy 3x-ui and Remnawave adapters while the client-mapping phase is
implemented.

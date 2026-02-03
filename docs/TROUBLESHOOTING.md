# Troubleshooting

Common issues and their solutions.

---

## Container Issues

### "401 Unauthorized" when pulling nanoclaw-agent image

**Error:**
```
Error: internalError: "HTTP request to https://registry-1.docker.io/v2/library/nanoclaw-agent/manifests/latest failed with response: 401 Unauthorized"
```

**Cause:** The local `nanoclaw-agent:latest` image doesn't exist, so Apple Container tries to pull it from Docker Hub.

**Solution:** Build the image locally:
```bash
./container/build.sh
```

Verify the image exists:
```bash
container image list
```

---

### "default kernel not configured for architecture arm64"

**Error:**
```
Error: notFound: "default kernel not configured for architecture arm64, please use the `container system kernel set` command to configure it"
```

**Cause:** Apple Container needs a Linux kernel configured to run containers.

**Solution:**
```bash
container system kernel set --recommended --force
```

---

### "XPC timeout for request to com.apple.container.apiserver"

**Error:**
```
Error: internalError: "failed to create container" (cause: "internalError: "XPC timeout for request to com.apple.container.apiserver/containerCreate"")
```

**Cause:** The Apple Container system services aren't running.

**Solution:**
```bash
container system start
```

---

### Container build fails after macOS update

After a macOS update, you may need to reconfigure Apple Container:

```bash
# Restart system services
container system start

# Reconfigure kernel if needed
container system kernel set --recommended --force

# Rebuild the image
./container/build.sh
```

---

## WhatsApp Issues

### Authentication expired

Re-run the authentication flow:
```bash
bun run auth
```

Scan the QR code with WhatsApp on your phone.

---

## Service Issues

### NanoClaw not starting on boot

Check if the LaunchAgent is loaded:
```bash
launchctl list | grep nanoclaw
```

Load it manually:
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

Check logs:
```bash
tail -f /tmp/nanoclaw.log
```

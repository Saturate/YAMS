#!/bin/sh
# Fix /data ownership for bind mounts (host creates dir as root)
chown -R yams:yams /data
exec su-exec yams "$@"

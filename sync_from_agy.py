#!/usr/bin/env python3
"""
Incremental real-time synchronizer from /root/.gemini into /workspace/agent-monitor/data/mirror.
Can be run with --once or --daemon (default interval 1.5s).
"""
import glob
import os
import shutil
import sys
import time

BRAIN_SRC = "/root/.gemini/antigravity-cli/brain"
AGENTS_SRC = "/root/.gemini/config/agents"
MIRROR_DST = "/workspace/agent-monitor/data/mirror"


def sync_file_if_changed(src: str, dst: str) -> bool:
    try:
        st_src = os.stat(src)
        if os.path.exists(dst):
            st_dst = os.stat(dst)
            if st_src.st_mtime <= st_dst.st_mtime and st_src.st_size == st_dst.st_size:
                return False
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
        return True
    except Exception:
        return False


def sync_once() -> int:
    copied = 0
    # 1. Global agent profiles
    if os.path.isdir(AGENTS_SRC):
        for md in glob.glob(os.path.join(AGENTS_SRC, "*", "agent.md")):
            agent_name = os.path.basename(os.path.dirname(md))
            dst = os.path.join(MIRROR_DST, "agents", agent_name, "agent.md")
            if sync_file_if_changed(md, dst):
                copied += 1

    # 2. Brain transcripts and custom session agents
    if os.path.isdir(BRAIN_SRC):
        for entry in os.scandir(BRAIN_SRC):
            if not entry.is_dir():
                continue
            cid = entry.name
            t_src = os.path.join(entry.path, ".system_generated", "logs", "transcript.jsonl")
            if os.path.isfile(t_src):
                t_dst = os.path.join(MIRROR_DST, "brain", cid, "transcript.jsonl")
                if sync_file_if_changed(t_src, t_dst):
                    copied += 1

            # Also check custom session-defined agents
            sess_agents_dir = os.path.join(entry.path, ".agents", "agents")
            if os.path.isdir(sess_agents_dir):
                for md in glob.glob(os.path.join(sess_agents_dir, "*", "agent.md")):
                    aname = os.path.basename(os.path.dirname(md))
                    dst = os.path.join(MIRROR_DST, "brain", cid, "agents", aname, "agent.md")
                    if sync_file_if_changed(md, dst):
                        copied += 1
    return copied


def main():
    os.makedirs(MIRROR_DST, exist_ok=True)
    if "--daemon" in sys.argv:
        while True:
            try:
                sync_once()
            except Exception:
                pass
            time.sleep(1.5)
    else:
        count = sync_once()
        print(f"Synced {count} updated files to {MIRROR_DST}")


if __name__ == "__main__":
    main()

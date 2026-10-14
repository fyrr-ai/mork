"""Assemble the runner filesystem from installed Debian packages and ELF dependencies."""
import os
from pathlib import Path
import re
import shutil
import subprocess

root = Path("/rootfs")
root.mkdir(exist_ok=True)
for name in ("bin", "sbin", "lib", "lib64"):
    (root / "usr" / name).mkdir(parents=True, exist_ok=True)
    (root / name).symlink_to(f"usr/{name}")

copied = set()
inodes = {}

def copy(path):
    source = Path(path)
    source = source.parent.resolve() / source.name
    if str(source) in copied or not source.exists():
        return
    copied.add(str(source))
    destination = root / source.relative_to("/")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_symlink():
        destination.symlink_to(os.readlink(source))
        copy(source.resolve())
    elif source.is_file():
        stat = source.stat()
        inode = (stat.st_dev, stat.st_ino)
        if inode in inodes:
            os.link(inodes[inode], destination)
        else:
            shutil.copy2(source, destination)
            inodes[inode] = destination
        # Resolve all transitive ELF libraries, including Python's loadable modules.
        with source.open("rb") as file:
            if file.read(4) == b"\x7fELF":
                result = subprocess.run(["ldd", str(source)], capture_output=True, text=True)
                if "not found" in result.stdout:
                    raise RuntimeError(f"Missing library for {source}: {result.stdout}")
                for library in re.findall(r"(?:=>\s+|^\s*)(/[^\s]+)", result.stdout, re.MULTILINE):
                    copy(library)

packages = [
    "libc6", "bash", "coreutils", "diffutils", "findutils", "grep", "sed", "mawk", "tar", "gzip",
    "git", "python3-minimal", "python3.13-minimal", "python3.13",
    "libpython3.13-minimal", "libpython3.13-stdlib", "ripgrep", "fd-find", "tzdata",
]
for package in packages:
    for path in subprocess.check_output(["dpkg-query", "-L", package], text=True).splitlines():
        if path.startswith(("/usr/bin/", "/bin/", "/usr/lib/", "/usr/share/git-core/", "/usr/share/zoneinfo/", "/etc/")) and "__pycache__" not in path:
            copy(path)

copy("/usr/local/bin/node")
for path in Path("/usr/local/lib/node_modules/npm").rglob("*"):
    copy(path)
for path in ("/usr/local/bin/npm", "/usr/local/bin/npx", "/bin/sh"):
    copy(path)
# Pi uses the name `fd`; Debian calls it fdfind.
(root / "usr/local/bin/fd").symlink_to("/usr/bin/fdfind")
for path in ("/etc/nsswitch.conf", "/etc/ssl/certs/ca-certificates.crt", "/etc/passwd", "/etc/group"):
    copy(path)
for path in Path("/usr/share/doc").glob("*/copyright"):
    copy(path)
for path in Path("/usr/local/share/doc/node").rglob("*"):
    copy(path)
for path in ("/work", "/home/agent", "/home/sandbox", "/tmp"):
    (root / path.lstrip("/")).mkdir(parents=True, exist_ok=True)
os.chmod(root / "tmp", 0o1777)
for user in ("agent", "sandbox"):
    shutil.chown(root / "home" / user, user=user, group=user)

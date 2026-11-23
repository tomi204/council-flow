"""Offline child launcher for Linux. Kernel restrictions survive exec and fork.
Run with /usr/bin/python3 -I. Any unsupported restriction aborts before exec.
"""
import ctypes as c
import errno
import os
import platform
import sys

libc = c.CDLL(None, use_errno=True)


def checked(result):
    if result < 0:
        raise OSError(c.get_errno(), "audit isolation unavailable")
    return result


def offline():
    sec = c.CDLL("libseccomp.so.2", use_errno=True)
    sec.seccomp_init.restype = c.c_void_p
    ctx = c.c_void_p(sec.seccomp_init(0x7fff0000))  # SCMP_ACT_ALLOW
    if not ctx:
        raise RuntimeError("seccomp initialization failed")
    deny = 0x00050000 | errno.EPERM
    blocked = ("socket", "connect", "bind", "sendto", "sendmsg", "sendmmsg",
                 "io_uring_setup", "ptrace", "process_vm_writev", "pidfd_getfd",
                 "mount", "setns", "unshare", "bpf")
    if sys.argv[1] == "test":
        # Landlock protects file contents. Metadata-only calls can otherwise change a
        # primary-checkout executable bit without ever opening the file for writing.
        blocked += ("chmod", "fchmod", "fchmodat", "fchmodat2", "chown", "fchown",
                    "lchown", "fchownat", "utime", "utimes", "futimesat", "utimensat",
                    "setxattr", "lsetxattr", "fsetxattr", "removexattr", "lremovexattr", "fremovexattr")
    for name in blocked:
        syscall = sec.seccomp_syscall_resolve_name(name.encode())
        if syscall < -1:  # libseccomp pseudo-number for a syscall absent on this architecture
            continue
        checked(syscall)
        checked(sec.seccomp_rule_add(ctx, deny, syscall, 0))
    checked(sec.seccomp_load(ctx))
    sec.seccomp_release(ctx)


def confine_test_files(scratch):
    # Landlock ABI 3+ handles truncation as well as writes and directory edits.
    if platform.machine() not in ("x86_64", "aarch64"):
        raise RuntimeError("unsupported Landlock architecture")
    create, add, restrict = 444, 445, 446
    if checked(libc.syscall(create, 0, 0, 1)) < 3:
        raise RuntimeError("Landlock ABI 3 required")
    access = (1 << 15) - 1
    readonly = (1 << 0) | (1 << 2) | (1 << 3)
    fd = checked(libc.syscall(create, c.byref(c.c_uint64(access)), 8, 0))

    class PathRule(c.Structure):
        _pack_ = 1
        _fields_ = [("access", c.c_uint64), ("parent", c.c_int32)]

    def allow(directory, rights):
        parent = os.open(directory, os.O_PATH | os.O_CLOEXEC)
        try:
            checked(libc.syscall(add, fd, 1, c.byref(PathRule(rights, parent)), 0))
        finally:
            os.close(parent)

    for directory in ("/usr", "/bin", "/lib", "/lib64", "/etc", "/proc/self",
                      "/sys/devices/system/cpu", os.environ["COUNCIL_NODE_PREFIX"]):
        if os.path.isdir(directory):
            allow(directory, readonly)
    for device in ("/dev/null", "/dev/urandom", "/dev/random"):
        allow(device, (1 << 1) | (1 << 2))
    allow(os.getcwd(), access)
    allow(scratch, access)
    checked(libc.syscall(restrict, fd, 0))
    os.close(fd)


checked(libc.prctl(38, 1, 0, 0, 0))  # PR_SET_NO_NEW_PRIVS
offline()
if sys.argv[1] == "test":
    confine_test_files(os.environ["TMPDIR"])
os.execvpe(sys.argv[2], sys.argv[2:], os.environ)

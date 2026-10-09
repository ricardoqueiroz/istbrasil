#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <sys/syscall.h>
#include <unistd.h>

enum {
    EXIT_USAGE = 64,
    EXIT_DESTINATION_EXISTS = 10,
    EXIT_UNAVAILABLE = 11,
    EXIT_CROSS_DEVICE = 12,
    EXIT_UNEXPECTED = 13
};

int main(int argc, char **argv) {
    if (argc != 3 || argv[1][0] != '/' || argv[2][0] != '/') return EXIT_USAGE;
#if !defined(SYS_renameat2) || !defined(RENAME_NOREPLACE)
    return EXIT_UNAVAILABLE;
#else
    if (syscall(SYS_renameat2, AT_FDCWD, argv[1], AT_FDCWD, argv[2], RENAME_NOREPLACE) == 0) return 0;
    if (errno == EEXIST) return EXIT_DESTINATION_EXISTS;
    if (errno == ENOSYS || errno == EINVAL) return EXIT_UNAVAILABLE;
    if (errno == EXDEV) return EXIT_CROSS_DEVICE;
    return EXIT_UNEXPECTED;
#endif
}

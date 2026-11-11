#include <ApplicationServices/ApplicationServices.h>
#include <CoreGraphics/CoreGraphics.h>
#include <errno.h>
#include <libgen.h>
#include <mach-o/dyld.h>
#include <pwd.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#define PATH_BUFFER_SIZE 4096

static volatile sig_atomic_t child_process_id = -1;

static const char *home_directory(void) {
  const char *home = getenv("HOME");
  if (home != NULL && home[0] != '\0') {
    return home;
  }

  struct passwd *account = getpwuid(getuid());
  return account == NULL ? NULL : account->pw_dir;
}

static int read_agent_root(char *destination, size_t capacity) {
  const char *home = home_directory();
  if (home == NULL) {
    return -1;
  }

  char config_path[PATH_BUFFER_SIZE];
  snprintf(config_path, sizeof(config_path),
           "%s/Library/Application Support/AIPendant/agent-root", home);

  FILE *config = fopen(config_path, "r");
  if (config == NULL) {
    fprintf(stderr, "AI Pendant agent root is not configured: %s\n",
            config_path);
    return -1;
  }

  if (fgets(destination, (int)capacity, config) == NULL) {
    fclose(config);
    return -1;
  }
  fclose(config);

  destination[strcspn(destination, "\r\n")] = '\0';
  return destination[0] == '\0' ? -1 : 0;
}

static void forward_signal(int signal_number) {
  pid_t child = (pid_t)child_process_id;
  if (child > 0) {
    kill(child, signal_number);
  }
}

static void install_signal_forwarding(void) {
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = forward_signal;
  sigemptyset(&action.sa_mask);

  sigaction(SIGTERM, &action, NULL);
  sigaction(SIGINT, &action, NULL);
  sigaction(SIGHUP, &action, NULL);
}

static void request_native_permissions(void) {
  CFMutableDictionaryRef accessibility_options =
      CFDictionaryCreateMutable(kCFAllocatorDefault, 1,
                                &kCFTypeDictionaryKeyCallBacks,
                                &kCFTypeDictionaryValueCallBacks);
  if (accessibility_options != NULL) {
    CFDictionarySetValue(accessibility_options,
                         kAXTrustedCheckOptionPrompt,
                         kCFBooleanTrue);
    AXIsProcessTrustedWithOptions(accessibility_options);
    CFRelease(accessibility_options);
  }

  CGRequestScreenCaptureAccess();
}

static int run_embedded_node(const char *node_path, char **node_argv) {
  install_signal_forwarding();

  pid_t child = fork();
  if (child < 0) {
    perror("Unable to fork the embedded AI Pendant runtime");
    return 1;
  }

  if (child == 0) {
    signal(SIGTERM, SIG_DFL);
    signal(SIGINT, SIG_DFL);
    signal(SIGHUP, SIG_DFL);
    execv(node_path, node_argv);
    perror("Unable to start the embedded AI Pendant runtime");
    _exit(127);
  }

  child_process_id = child;
  int status = 0;
  while (waitpid(child, &status, 0) < 0) {
    if (errno != EINTR) {
      perror("Unable to wait for the embedded AI Pendant runtime");
      return 1;
    }
  }
  child_process_id = -1;

  if (WIFEXITED(status)) {
    return WEXITSTATUS(status);
  }
  if (WIFSIGNALED(status)) {
    return 128 + WTERMSIG(status);
  }
  return 1;
}

int main(int argc, char **argv) {
  char executable_path[PATH_BUFFER_SIZE];
  uint32_t executable_path_size = sizeof(executable_path);
  if (_NSGetExecutablePath(executable_path, &executable_path_size) != 0) {
    fprintf(stderr, "Unable to locate AI Pendant Agent.app\n");
    return 1;
  }

  char executable_copy[PATH_BUFFER_SIZE];
  strncpy(executable_copy, executable_path, sizeof(executable_copy) - 1);
  executable_copy[sizeof(executable_copy) - 1] = '\0';
  const char *macos_directory = dirname(executable_copy);

  char node_path[PATH_BUFFER_SIZE];
  snprintf(node_path, sizeof(node_path), "%s/../Resources/node",
           macos_directory);

  char agent_root[PATH_BUFFER_SIZE];
  if (read_agent_root(agent_root, sizeof(agent_root)) != 0 ||
      chdir(agent_root) != 0) {
    perror("Unable to enter the AI Pendant project");
    return 1;
  }

  setenv("__CFBundleIdentifier", "com.aipendant.agent", 1);
  const char *mode = argc > 1 ? argv[1] : "agent";
  if (strcmp(mode, "setup") == 0) {
    // Make macOS attribute the prompts to this signed app bundle, not to
    // whichever terminal or Node installation happened to run the installer.
    request_native_permissions();
  }

  const char *script = strcmp(mode, "bridge") == 0
                           ? "local-agent/runBridge.js"
                           : strcmp(mode, "setup") == 0
                                 ? "local-agent/macos/setupPermissions.js"
                                 : "local-agent/server.js";

  char **node_argv = calloc((size_t)argc + 3, sizeof(char *));
  if (node_argv == NULL) {
    return 1;
  }
  int node_argc = 0;
  node_argv[node_argc++] = node_path;
  node_argv[node_argc++] = (char *)script;
  if (strcmp(mode, "setup") == 0) {
    node_argv[node_argc++] = "--inside-app";
    for (int index = 2; index < argc; index += 1) {
      node_argv[node_argc++] = argv[index];
    }
  }
  node_argv[node_argc] = NULL;

  int exit_code = run_embedded_node(node_path, node_argv);
  free(node_argv);
  return exit_code;
}

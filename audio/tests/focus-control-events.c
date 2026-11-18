#define _GNU_SOURCE
#include <pipewire/pipewire.h>
#include <spa/param/props.h>
#include <spa/pod/builder.h>
#include <spa/pod/iter.h>
#include <stdio.h>
#include <stdlib.h>
#include <poll.h>
#include <sys/wait.h>
#include <time.h>

#define CHECK(condition) do { if (!(condition)) { \
    fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #condition); exit(1); \
} } while (0)

static int fake_quit(struct pw_main_loop *loop);
static int fake_sync(struct pw_core *core, uint32_t id, int seq);
static int fake_enum(struct pw_node *node, int seq, uint32_t id, uint32_t start,
                     uint32_t num, const struct spa_pod *filter);
static int fake_set(struct pw_node *node, uint32_t id, uint32_t flags, const struct spa_pod *pod);
static void *fake_bind(struct pw_registry *registry, uint32_t id, const char *type,
                       uint32_t version, size_t size);
static void fake_proxy_listener(struct pw_proxy *proxy, struct spa_hook *hook,
                                const struct pw_proxy_events *events, void *data);
static int fake_node_listener(struct pw_node *node, struct spa_hook *hook,
                              const struct pw_node_events *events, void *data);
static void forbidden_init(int *argc, char ***argv);

#define pw_main_loop_quit fake_quit
#define pw_core_sync fake_sync
#define pw_node_enum_params fake_enum
#define pw_node_set_param fake_set
#define pw_registry_bind fake_bind
#define pw_proxy_add_listener fake_proxy_listener
#define pw_node_add_listener fake_node_listener
#define pw_init forbidden_init
#define main focus_production_main
#include "../focus-control.c"
#undef main

static int loop_handle, core_handle, registry_handle, node_handle;
static struct {
    int syncs, enums, writes, binds, quits;
    int enum_result, set_result;
    const struct pw_node_events *node_events;
    const struct pw_proxy_events *proxy_events;
    void *node_data, *proxy_data;
} fake;
static struct spa_dict_item items[] = {
    { PW_KEY_OBJECT_SERIAL, "91" }, { PW_KEY_MEDIA_CLASS, "Stream/Output/Audio" },
    { PW_KEY_APP_ID, "org.example.Music" }, { PW_KEY_APP_PROCESS_BINARY, "music" },
    { PW_KEY_MEDIA_ROLE, "Music" }, { PW_KEY_NODE_NAME, "music-output" },
};
static struct spa_dict props = SPA_DICT_INIT(items, SPA_N_ELEMENTS(items));

static int fake_quit(struct pw_main_loop *loop) {
    CHECK(loop == (struct pw_main_loop *)&loop_handle);
    fake.quits++;
    return 0;
}
static int fake_sync(struct pw_core *core, uint32_t id, int seq) {
    CHECK(core == (struct pw_core *)&core_handle && id == PW_ID_CORE && seq == 0);
    return ++fake.syncs;
}
static int fake_enum(struct pw_node *node, int seq, uint32_t id, uint32_t start,
                     uint32_t num, const struct spa_pod *filter) {
    CHECK(node == (struct pw_node *)&node_handle);
    CHECK(seq == 0 && id == SPA_PARAM_Props && start == 0 && num == 2 && filter == NULL);
    fake.enums++;
    return fake.enum_result;
}
static int fake_set(struct pw_node *node, uint32_t id, uint32_t flags, const struct spa_pod *pod) {
    CHECK(node == (struct pw_node *)&node_handle && fake.binds == 1);
    CHECK(id == SPA_PARAM_Props && flags == 0 && spa_pod_is_object(pod));
    CHECK(SPA_POD_OBJECT_TYPE(pod) == SPA_TYPE_OBJECT_Props);
    const struct spa_pod_prop *p;
    int count = 0;
    SPA_POD_OBJECT_FOREACH((const struct spa_pod_object *)pod, p) {
        CHECK(p->key == SPA_PROP_channelVolumes);
        uint32_t n, size, type;
        const float *values = spa_pod_get_array_full(&p->value, &n, &size, &type);
        CHECK(values && n == 2 && size == sizeof(float) && type == SPA_TYPE_Float);
        CHECK(values[0] == 0.2f && values[1] == 0.1f);
        count++;
    }
    CHECK(count == 1);
    fake.writes++;
    return fake.set_result;
}
static void *fake_bind(struct pw_registry *registry, uint32_t id, const char *type,
                       uint32_t version, size_t size) {
    CHECK(registry == (struct pw_registry *)&registry_handle && id == 32);
    CHECK(strcmp(type, PW_TYPE_INTERFACE_Node) == 0 && version == PW_VERSION_NODE && size == 0);
    CHECK(fake.binds == 0);
    fake.binds++;
    return &node_handle;
}
static void fake_proxy_listener(struct pw_proxy *proxy, struct spa_hook *hook,
                                const struct pw_proxy_events *events, void *data) {
    CHECK(proxy == (struct pw_proxy *)&node_handle && hook && events == &proxy_events);
    fake.proxy_events = events; fake.proxy_data = data;
}
static int fake_node_listener(struct pw_node *node, struct spa_hook *hook,
                              const struct pw_node_events *events, void *data) {
    CHECK(node == (struct pw_node *)&node_handle && hook && events == &node_events);
    fake.node_events = events; fake.node_data = data;
    return 0;
}
static void forbidden_init(int *argc, char ***argv) {
    (void)argc; (void)argv;
    CHECK(false);
}
static void reset_fixture(struct state *s) {
    memset(&fake, 0, sizeof(fake));
    *s = (struct state){ .loop = (struct pw_main_loop *)&loop_handle,
        .core = (struct pw_core *)&core_handle, .registry = (struct pw_registry *)&registry_handle,
        .cookie = 123, .id = 32, .serial = "91", .app = "org.example.Music",
        .binary = "music", .role = "Music", .name = "music-output", .channels = 2,
        .expected = { 1, 0.5f }, .desired = { 0.2f, 0.1f } };
    const struct pw_core_info info = { .cookie = 123 };
    core_events.info(s, &info);
}
static void fixture(struct state *s) {
    reset_fixture(s);
    registry_events.global(s, 32, PW_PERM_R | PW_PERM_W | PW_PERM_X,
        PW_TYPE_INTERFACE_Node, PW_VERSION_NODE, &props);
    CHECK(fake.binds == 1 && fake.node_data == s && fake.proxy_data == s);
    sync_next(s);
}
static void bound_info(struct state *s, uint32_t id, const struct spa_dict *metadata) {
    struct pw_node_info info = { .id = id, .change_mask = PW_NODE_CHANGE_MASK_PROPS,
        .props = (struct spa_dict *)metadata };
    fake.node_events->info(s, &info);
}
static void done(struct state *s) { core_events.done(s, PW_ID_CORE, s->pending); }
static void param(struct state *s, const float *volumes, bool mute) {
    uint8_t buffer[1024];
    struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
    const struct spa_pod *pod = spa_pod_builder_add_object(&b, SPA_TYPE_OBJECT_Props, SPA_PARAM_Props,
        SPA_PROP_mute, SPA_POD_Bool(mute),
        SPA_PROP_channelVolumes, SPA_POD_Array(sizeof(float), SPA_TYPE_Float, 2, volumes));
    fake.node_events->param(s, 0, SPA_PARAM_Props, 0, 0, pod);
}
static void before_write(struct state *s) {
    fixture(s);
    done(s);
    bound_info(s, 32, &props);
    done(s);
    CHECK(s->phase == 2 && fake.enums == 1 && fake.writes == 0);
    param(s, s->expected, s->mute);
    CHECK(s->params_ok && !s->failed);
}
static void valid_sequence(void) {
    struct state s;
    before_write(&s);
    done(&s);
    CHECK(s.phase == 3 && fake.writes == 1 && !s.success);
    done(&s);
    CHECK(s.phase == 4 && fake.enums == 2 && !s.success);
    param(&s, s.desired, s.mute);
    CHECK(!s.success);
    done(&s);
    CHECK(s.success && !s.failed && fake.writes == 1 && fake.quits == 1);
    CHECK(fake.syncs == 5);
    puts("native callbacks: bound proxy, one gains-only write, sync/readback acknowledgement");
}
static void no_late_write(struct state *s, int writes) {
    CHECK(s->failed && !s->success && fake.writes == writes);
    bound_info(s, 32, &props);
    param(s, s->expected, s->mute);
    done(s);
    CHECK(s->failed && !s->success && fake.writes == writes);
}
static void wrong_bound_identity(void) {
    struct state s;
    fixture(&s);
    done(&s);
    bound_info(&s, 33, &props);
    no_late_write(&s, 0);
    fixture(&s);
    done(&s);
    items[0].value = "92";
    bound_info(&s, 32, &props);
    items[0].value = "91";
    no_late_write(&s, 0);
    fixture(&s);
    const struct pw_core_info restarted = { .cookie = 124 };
    core_events.info(&s, &restarted);
    no_late_write(&s, 0);
    puts("native callbacks: wrong bound ID/serial and restarted core prevent writes");
}
static void stale_sequences(void) {
    struct state s;
    before_write(&s);
    const int pending = s.pending, syncs = fake.syncs;
    core_events.done(&s, PW_ID_CORE, pending - 1);
    core_events.done(&s, PW_ID_CORE, pending + 1);
    core_events.done(&s, 99, pending);
    CHECK(s.phase == 2 && s.pending == pending && fake.writes == 0 && fake.syncs == syncs);
    done(&s);
    CHECK(s.phase == 3 && fake.writes == 1);
    puts("native callbacks: stale or wrong-object core_done never advances");
}
static void removal_and_errors(void) {
    struct state s;
    before_write(&s);
    fake.proxy_events->removed(&s);
    no_late_write(&s, 0);
    before_write(&s);
    registry_events.global_remove(&s, 32);
    no_late_write(&s, 0);
    before_write(&s);
    fake.proxy_events->error(&s, 0, -EACCES, "permission denied");
    no_late_write(&s, 0);
    before_write(&s);
    core_events.error(&s, 32, s.pending, -EACCES, "permission denied");
    no_late_write(&s, 0);
    before_write(&s);
    timeout_event(&s, 1);
    no_late_write(&s, 0);
    puts("native callbacks: proxy/registry removal, permission error and timeout cannot resurrect writes");
}
static void permission_failures(void) {
    struct state s;
    reset_fixture(&s);
    registry_events.global(&s, 32, PW_PERM_R, PW_TYPE_INTERFACE_Node, PW_VERSION_NODE, &props);
    CHECK(s.failed && !s.success && fake.binds == 0 && fake.writes == 0);
    fixture(&s);
    done(&s);
    bound_info(&s, 32, &props);
    fake.enum_result = -EACCES;
    done(&s);
    no_late_write(&s, 0);
    before_write(&s);
    fake.set_result = -EACCES;
    done(&s);
    no_late_write(&s, 1);
    puts("native callbacks: registry/enum/write permissions fail closed without acknowledgement");
}
static void failed_readbacks(void) {
    struct state s;
    before_write(&s);
    done(&s); done(&s);
    CHECK(s.phase == 4 && fake.writes == 1);
    done(&s);
    no_late_write(&s, 1);
    before_write(&s);
    done(&s); done(&s);
    param(&s, s.expected, s.mute);
    done(&s);
    no_late_write(&s, 1);
    before_write(&s);
    done(&s); done(&s);
    param(&s, s.desired, !s.mute);
    done(&s);
    no_late_write(&s, 1);
    puts("native callbacks: missing/mismatched gains or mute readback never acknowledge success");
}
static int64_t monotonic_ms(void) {
    struct timespec now;
    CHECK(clock_gettime(CLOCK_MONOTONIC, &now) == 0);
    return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}
static int bounded_wait(pid_t child, int *status) {
    const int64_t deadline = monotonic_ms() + 2000;
    do {
        pid_t result = waitpid(child, status, WNOHANG);
        if (result == child) return 1;
        if (result < 0 && errno != EINTR) return -1;
        struct timespec delay = { .tv_nsec = 10000000 };
        nanosleep(&delay, NULL);
    } while (monotonic_ms() < deadline);
    return 0;
}
static bool parent_death_signal(void) {
    int prior_subreaper;
    CHECK(prctl(PR_GET_CHILD_SUBREAPER, &prior_subreaper) == 0);
    CHECK(prctl(PR_SET_CHILD_SUBREAPER, 1) == 0);
    int ready[2], release[2];
    CHECK(pipe(ready) == 0 && pipe(release) == 0);
    struct report { pid_t pid; int stage; } report;
    const pid_t controller = fork();
    CHECK(controller >= 0);
    if (controller == 0) {
        close(ready[0]); close(release[1]);
        if (setpgid(0, 0) < 0) _exit(72);
        const pid_t child = fork();
        if (child == 0) {
            close(release[0]);
            report = (struct report){ .pid = getpid(), .stage = install_parent_guard() ? 1 : -1 };
            if (write(ready[1], &report, sizeof(report)) != sizeof(report)) _exit(73);
            close(ready[1]);
            if (report.stage != 1) _exit(74);
            for (;;) pause();
        }
        report = (struct report){ .pid = child, .stage = 0 };
        if (write(ready[1], &report, sizeof(report)) != sizeof(report)) _exit(75);
        close(ready[1]);
        char command = 0;
        const ssize_t count = read(release[0], &command, 1);
        close(release[0]);
        _exit(child > 0 && count == 1 && command == 'x' ? 0 : 76);
    }
    close(ready[1]); close(release[0]);
    pid_t helper = -1;
    bool spawned = false, guarded = false;
    for (int i = 0; i < 2; i++) {
        struct pollfd fd = { .fd = ready[0], .events = POLLIN };
        if (poll(&fd, 1, 2000) != 1 || read(ready[0], &report, sizeof(report)) != sizeof(report)) break;
        if (report.pid <= 0 || (helper > 0 && helper != report.pid)) break;
        helper = report.pid;
        if (report.stage == 0) spawned = true;
        if (report.stage == 1) guarded = true;
    }
    close(ready[0]);
    bool pass = spawned && guarded;
    if (pass && write(release[1], "x", 1) != 1) pass = false;
    close(release[1]);
    int controller_status = 0, helper_status = 0;
    const int controller_reaped = bounded_wait(controller, &controller_status);
    pass = pass && controller_reaped == 1 && WIFEXITED(controller_status) && WEXITSTATUS(controller_status) == 0;
    const int helper_reaped = helper > 0 ? bounded_wait(helper, &helper_status) : -1;
    pass = pass && helper_reaped == 1 && WIFSIGNALED(helper_status) && WTERMSIG(helper_status) == SIGKILL;
    /* Cleanup cannot turn a timeout into proof of PDEATHSIG: pass is final above. */
    if (!pass) {
        kill(-controller, SIGKILL);
        if (controller_reaped != 1) kill(controller, SIGKILL);
        if (helper > 0 && helper_reaped != 1) kill(helper, SIGKILL);
    }
    int status;
    const int64_t deadline = monotonic_ms() + 2000;
    bool all_reaped = false;
    do {
        const pid_t child = waitpid(-1, &status, WNOHANG);
        if (child < 0 && errno == ECHILD) { all_reaped = true; break; }
        if (child < 0 && errno != EINTR) break;
        struct timespec delay = { .tv_nsec = 10000000 };
        nanosleep(&delay, NULL);
    } while (monotonic_ms() < deadline);
    CHECK(prctl(PR_SET_CHILD_SUBREAPER, prior_subreaper) == 0);
    return pass && all_reaped;
}
int main(void) {
    alarm(15);
    valid_sequence();
    wrong_bound_identity();
    stale_sequences();
    removal_and_errors();
    permission_failures();
    failed_readbacks();
    char *args[] = { "offline-focus-control", "--self-test", NULL };
    CHECK(focus_production_main(2, args) == 0);
    CHECK(parent_death_signal());
    puts("native Linux guard: ready main-thread helper receives SIGKILL on parent exit; all children reaped");
    return 0;
}

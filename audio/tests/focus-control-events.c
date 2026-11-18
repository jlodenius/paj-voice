#define _GNU_SOURCE
#include <pipewire/pipewire.h>
#include <spa/param/props.h>
#include <spa/pod/builder.h>
#include <spa/pod/iter.h>
#include <spa/utils/result.h>
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
static int fake_client_listener(struct pw_client *client, struct spa_hook *hook,
                                const struct pw_client_events *events, void *data);
static void forbidden_init(int *argc, char ***argv);

#define pw_main_loop_quit fake_quit
#define pw_core_sync fake_sync
#define pw_node_enum_params fake_enum
#define pw_node_set_param fake_set
#define pw_registry_bind fake_bind
#define pw_proxy_add_listener fake_proxy_listener
#define pw_node_add_listener fake_node_listener
#define pw_client_add_listener fake_client_listener
#define pw_init forbidden_init
#define main focus_production_main
#include "../focus-control.c"
#undef main

static int loop_handle, core_handle, registry_handle, node_handle, client_handle;
static struct {
    int syncs, enums, writes, binds, client_binds, quits;
    int enum_result, set_result, enum_seq;
    const struct pw_node_events *node_events;
    const struct pw_proxy_events *proxy_events;
    void *node_data, *proxy_data;
    const struct pw_client_events *client_events;
    const struct pw_proxy_events *client_proxy_events;
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
    CHECK(seq >= 0 && id == SPA_PARAM_Props && start == 0 && num == 2 && filter == NULL);
    fake.enum_seq = SPA_RESULT_IS_ASYNC(fake.enum_result) ? fake.enum_result : seq; fake.enums++;
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
        const struct state *s = fake.node_data;
        CHECK(values[0] == s->desired[0] && values[1] == s->desired[1]);
        count++;
    }
    CHECK(count == 1);
    fake.writes++;
    return fake.set_result;
}
static void *fake_bind(struct pw_registry *registry, uint32_t id, const char *type,
                       uint32_t version, size_t size) {
    CHECK(registry == (struct pw_registry *)&registry_handle);
    if (id == 7) {
        CHECK(strcmp(type, PW_TYPE_INTERFACE_Client) == 0 && version == PW_VERSION_CLIENT && size == 0);
        CHECK(fake.client_binds++ == 0);
        return &client_handle;
    }
    CHECK(id == 32);
    CHECK(strcmp(type, PW_TYPE_INTERFACE_Node) == 0 && version == PW_VERSION_NODE && size == 0);
    CHECK(fake.binds == 0);
    fake.binds++;
    return &node_handle;
}
static void fake_proxy_listener(struct pw_proxy *proxy, struct spa_hook *hook,
                                const struct pw_proxy_events *events, void *data) {
    if (proxy == (struct pw_proxy *)&client_handle) {
        CHECK(hook && events == &proxy_events); fake.client_proxy_events = events; return;
    }
    CHECK(proxy == (struct pw_proxy *)&node_handle && hook && events == &proxy_events);
    fake.proxy_events = events; fake.proxy_data = data;
}
static int fake_node_listener(struct pw_node *node, struct spa_hook *hook,
                              const struct pw_node_events *events, void *data) {
    CHECK(node == (struct pw_node *)&node_handle && hook && events == &node_events);
    fake.node_events = events; fake.node_data = data;
    return 0;
}
static int fake_client_listener(struct pw_client *client, struct spa_hook *hook,
                                const struct pw_client_events *events, void *data) {
    CHECK(client == (struct pw_client *)&client_handle && hook && data);
    fake.client_events = events;
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
static void param_request(struct state *s, int seq, uint32_t id, uint32_t type,
                          const float *volumes, bool mute) {
    uint8_t buffer[1024];
    struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
    const struct spa_pod *pod = spa_pod_builder_add_object(&b, type, SPA_PARAM_Props,
        SPA_PROP_mute, SPA_POD_Bool(mute),
        SPA_PROP_channelVolumes, SPA_POD_Array(sizeof(float), SPA_TYPE_Float, 2, volumes));
    fake.node_events->param(s, seq, id, 0, 0, pod);
}
static void param(struct state *s, const float *volumes, bool mute) {
    param_request(s, fake.enum_seq, SPA_PARAM_Props, SPA_TYPE_OBJECT_Props, volumes, mute);
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
static struct spa_dict_item client_items[] = {
    { PW_KEY_OBJECT_SERIAL, "70" }, { PW_KEY_APP_PROCESS_BINARY, "helium" },
};
static struct spa_dict client_props = SPA_DICT_INIT(client_items, SPA_N_ELEMENTS(client_items));
static struct spa_dict_item minimal_items[] = {
    { PW_KEY_OBJECT_SERIAL, "91" }, { PW_KEY_MEDIA_CLASS, "Stream/Output/Audio" },
    { PW_KEY_NODE_NAME, "music-output" }, { PW_KEY_CLIENT_ID, "7" },
};
static struct spa_dict minimal_props = SPA_DICT_INIT(minimal_items, SPA_N_ELEMENTS(minimal_items));
static void client_info_event(struct state *s, uint32_t id, const struct spa_dict *metadata) {
    struct pw_client_info info = { .id = id, .change_mask = PW_CLIENT_CHANGE_MASK_PROPS,
        .props = (struct spa_dict *)metadata };
    fake.client_events->info(s, &info);
}
static void inherited_ready(struct state *s) {
    reset_fixture(s);
    s->app = ""; s->binary = "helium"; s->role = "";
    s->associated = true; s->inherit = true; s->client_id = 7; s->client_serial = "70";
    s->client_app = ""; s->client_binary = "helium"; s->client_role = "";
    s->client_name = ""; s->client_application_name = "";
    registry_events.global(s, 32, PW_PERM_R | PW_PERM_W | PW_PERM_X,
        PW_TYPE_INTERFACE_Node, PW_VERSION_NODE, &minimal_props);
    registry_events.global(s, 7, PW_PERM_R, PW_TYPE_INTERFACE_Client, PW_VERSION_CLIENT, &client_props);
    CHECK(fake.client_binds == 1 && fake.client_events && fake.client_proxy_events);
    sync_next(s); done(s);
    bound_info(s, 32, &minimal_props); client_info_event(s, 7, &client_props);
    done(s); CHECK(s->phase == 2 && !s->failed);
}
static void inherited_before_write(struct state *s) {
    inherited_ready(s);
    param(s, s->expected, s->mute);
}
static void associated_client_sequence(void) {
    struct state s;
    inherited_before_write(&s); done(&s); done(&s); param(&s, s.desired, false); done(&s);
    CHECK(s.success && !s.failed && fake.writes == 1 && fake.client_binds == 1);
    for (int all = 0; all < 2; all++) for (int readback = 0; readback < 2; readback++) {
        for (int fault = 0; fault < 12; fault++) {
            inherited_before_write(&s); s.all = all;
            if (readback) { done(&s); done(&s); param(&s, s.desired, false); }
            switch (fault) {
            case 0: client_items[0].value = "71"; client_info_event(&s, 7, &client_props);
                client_items[0].value = "70"; break;
            case 1: client_info_event(&s, 8, &client_props); break;
            case 2: registry_events.global_remove(&s, 7); break;
            case 3: fake.client_proxy_events->removed(&s); break;
            case 4: minimal_items[3].value = "8"; bound_info(&s, 32, &minimal_props);
                minimal_items[3].value = "7"; break;
            case 5: client_items[1].value = "other"; client_info_event(&s, 7, &client_props);
                client_items[1].value = "helium"; break;
            case 6: registry_events.global(&s, 7, PW_PERM_R, PW_TYPE_INTERFACE_Client,
                PW_VERSION_CLIENT, &client_props); break;
            case 7: fake.client_proxy_events->error(&s, 0, -ENOENT, "gone"); break;
            default: {
                const char *keys[] = { PW_KEY_MEDIA_ROLE, PW_KEY_NODE_NAME, PW_KEY_APP_NAME };
                struct spa_dict_item changed_items[] = {
                    { PW_KEY_OBJECT_SERIAL, "70" }, { PW_KEY_APP_PROCESS_BINARY, "helium" },
                    { fault == 8 ? PW_KEY_APP_ID : keys[fault - 9], "changed" },
                };
                struct spa_dict changed = SPA_DICT_INIT(changed_items + (fault == 8), 3 - (fault == 8));
                client_info_event(&s, 7, &changed); break;
            }
            }
            CHECK(s.failed && !s.success);
            client_info_event(&s, 7, &client_props); bound_info(&s, 32, &minimal_props);
            done(&s);
            CHECK(s.failed && !s.success && fake.writes == readback);
        }
    }
    puts("native callbacks: immutable Client binding and actual Node association fence write/readback and stale callbacks");
}
static void associated_client_guards(void) {
    struct state s;
    inherited_before_write(&s);
    struct spa_dict_item invalid_items[] = {
        { PW_KEY_OBJECT_SERIAL, "70" }, { PW_KEY_APP_PROCESS_BINARY, "https://invalid.example" },
    };
    struct spa_dict invalid = SPA_DICT_INIT(invalid_items, 2);
    s.client_binary = invalid_items[1].value; s.binary = invalid_items[1].value;
    client_info_event(&s, 7, &invalid);
    CHECK(s.failed && fake.writes == 0);
    for (int restore = 0; restore < 2; restore++) {
        inherited_ready(&s); s.restore = restore;
        if (restore) {
            s.expected[0] = 0.2f; s.expected[1] = 0.1f;
            s.desired[0] = 1.0f; s.desired[1] = 0.5f;
        }
        struct spa_dict_item call_items[] = {
            { PW_KEY_OBJECT_SERIAL, "70" }, { PW_KEY_APP_PROCESS_BINARY, "helium" },
            { PW_KEY_MEDIA_ROLE, "Communication" },
        };
        struct spa_dict call = SPA_DICT_INIT(call_items, 3);
        s.client_role = "Communication"; client_info_event(&s, 7, &call);
        if (restore) {
            CHECK(!s.failed); param(&s, s.expected, false); done(&s); done(&s);
            param(&s, s.desired, false); done(&s); CHECK(s.success && fake.writes == 1);
        } else { CHECK(s.failed && fake.writes == 0); }
        for (int guard = 0; guard < 4; guard++) {
            inherited_before_write(&s); s.restore = restore;
            struct spa_dict_item voice_items[] = {
                { PW_KEY_OBJECT_SERIAL, "70" }, { PW_KEY_APP_PROCESS_BINARY, "helium" },
                { PW_KEY_APP_ID, "org.paj.voice" },
            };
            if (guard == 0) { s.client_app = "org.paj.voice"; s.app = "org.paj.voice"; }
            if (guard == 1) { voice_items[2] = SPA_DICT_ITEM_INIT("paj.voice.owner", ""); }
            if (guard == 2) { voice_items[2] = SPA_DICT_ITEM_INIT(PW_KEY_NODE_NAME, "paj_voice_play-extra");
                s.client_name = voice_items[2].value; }
            if (guard == 3) { voice_items[2] = SPA_DICT_ITEM_INIT(PW_KEY_APP_NAME, "paj_voice_play-extra");
                s.client_application_name = voice_items[2].value; }
            struct spa_dict voice = SPA_DICT_INIT(voice_items, 3);
            client_info_event(&s, 7, &voice); done(&s); CHECK(s.failed && fake.writes == 0 && !s.success);
        }
    }
    inherited_before_write(&s);
    struct spa_dict_item explicit_items[] = {
        { PW_KEY_OBJECT_SERIAL, "91" }, { PW_KEY_MEDIA_CLASS, "Stream/Output/Audio" },
        { PW_KEY_NODE_NAME, "music-output" }, { PW_KEY_CLIENT_ID, "7" },
        { PW_KEY_APP_ID, "org.node.Player" },
    };
    struct spa_dict explicit = SPA_DICT_INIT(explicit_items, 5);
    bound_info(&s, 32, &explicit); CHECK(s.failed && fake.writes == 0);
    inherited_before_write(&s); s.inherit = false; s.app = "org.node.Player"; s.binary = "";
    bound_info(&s, 32, &explicit); CHECK(!s.failed); done(&s); done(&s);
    param(&s, s.desired, false); done(&s); CHECK(s.success && fake.writes == 1);
    fixture(&s);
    bound_info(&s, 32, &explicit); CHECK(s.failed && fake.writes == 0);
    inherited_before_write(&s);
    struct spa_dict_item duplicate_items[] = {
        { PW_KEY_OBJECT_SERIAL, "70" }, { PW_KEY_APP_PROCESS_BINARY, "helium" },
        { PW_KEY_APP_PROCESS_BINARY, "other" },
    };
    struct spa_dict duplicate = SPA_DICT_INIT(duplicate_items, 3);
    client_info_event(&s, 7, &duplicate); CHECK(s.failed && fake.writes == 0);
    reset_fixture(&s); s.associated = true; s.client_id = 7; s.client_serial = "71";
    registry_events.global(&s, 7, PW_PERM_R, PW_TYPE_INTERFACE_Client, PW_VERSION_CLIENT, &client_props);
    CHECK(s.failed && fake.client_binds == 0);
    puts("native callbacks: Client role/Voice guards, monotonic restore, invalid/duplicate metadata and Node identity precedence");
}
static void all_other_playback(void) {
    struct state s;
    for (int associated = 0; associated < 2; associated++) {
        reset_fixture(&s); s.app = ""; s.binary = ""; s.role = ""; s.all = true;
        struct spa_dict anonymous_node = SPA_DICT_INIT(minimal_items, associated ? 4 : 3);
        if (associated) {
            s.associated = true; s.inherit = true; s.client_id = 7; s.client_serial = "70";
            s.client_app = ""; s.client_binary = ""; s.client_role = "";
            s.client_name = ""; s.client_application_name = "";
            struct spa_dict anonymous_client = SPA_DICT_INIT(client_items, 1);
            registry_events.global(&s, 7, PW_PERM_R, PW_TYPE_INTERFACE_Client, PW_VERSION_CLIENT, &anonymous_client);
            client_info_event(&s, 7, &anonymous_client);
        }
        registry_events.global(&s, 32, PW_PERM_R | PW_PERM_W | PW_PERM_X,
            PW_TYPE_INTERFACE_Node, PW_VERSION_NODE, &anonymous_node);
        sync_next(&s); done(&s); bound_info(&s, 32, &anonymous_node); done(&s);
        CHECK(!s.failed && s.phase == 2); param(&s, s.expected, false); done(&s); done(&s);
        param(&s, s.desired, false); done(&s); CHECK(s.success && !s.failed && fake.writes == 1);
    }
    const char *roles[] = { "Communication", "Alert", "Voice" };
    for (size_t i = 0; i < SPA_N_ELEMENTS(roles); i++) {
        for (int client_role = 0; client_role < 2; client_role++) {
            inherited_before_write(&s); s.all = true;
            struct spa_dict_item changed_items[] = {
                { PW_KEY_OBJECT_SERIAL, "70" }, { PW_KEY_APP_PROCESS_BINARY, "helium" },
                { PW_KEY_MEDIA_ROLE, roles[i] },
            };
            if (client_role) {
                s.client_role = roles[i]; struct spa_dict changed = SPA_DICT_INIT(changed_items, 3);
                client_info_event(&s, 7, &changed);
            } else {
                struct spa_dict_item node_items[] = {
                    { PW_KEY_OBJECT_SERIAL, "91" }, { PW_KEY_MEDIA_CLASS, "Stream/Output/Audio" },
                    { PW_KEY_NODE_NAME, "music-output" }, { PW_KEY_CLIENT_ID, "7" },
                    { PW_KEY_MEDIA_ROLE, roles[i] },
                };
                s.role = roles[i]; struct spa_dict changed = SPA_DICT_INIT(node_items, 5);
                bound_info(&s, 32, &changed);
            }
            CHECK(!s.failed); done(&s); done(&s); param(&s, s.desired, false); done(&s);
            CHECK(s.success && fake.writes == 1);
        }
    }
    inherited_before_write(&s); s.all = true; s.mute = true; done(&s);
    CHECK(s.failed && fake.writes == 0);
    inherited_before_write(&s); s.all = true; s.restore = true; done(&s);
    CHECK(s.failed && fake.writes == 0);
    for (int client_voice = 0; client_voice < 2; client_voice++)
    for (int guard = 0; guard < 4; guard++) for (int restore = 0; restore < 2; restore++) {
        inherited_before_write(&s); s.all = true; s.restore = restore;
        if (restore) {
            s.expected[0] = 0.2f; s.expected[1] = 0.1f;
            s.desired[0] = 1.0f; s.desired[1] = 0.5f;
        }
        if (client_voice) {
            struct spa_dict_item own_items[] = {
                { PW_KEY_OBJECT_SERIAL, "70" }, { PW_KEY_APP_PROCESS_BINARY, "helium" },
                { "paj.voice.owner", "owner" },
            };
            if (guard == 1) { own_items[2] = SPA_DICT_ITEM_INIT(PW_KEY_APP_ID, "org.paj.voice");
                s.client_app = "org.paj.voice"; s.app = "org.paj.voice"; }
            if (guard == 2) { own_items[2] = SPA_DICT_ITEM_INIT(PW_KEY_NODE_NAME, "paj_voice_play: stream (1)");
                s.client_name = own_items[2].value; }
            if (guard == 3) { own_items[2] = SPA_DICT_ITEM_INIT(PW_KEY_APP_NAME, "paj_voice_play: stream (1)");
                s.client_application_name = own_items[2].value; }
            struct spa_dict own = SPA_DICT_INIT(own_items, 3); client_info_event(&s, 7, &own);
        } else {
            struct spa_dict_item own_items[] = {
                { PW_KEY_OBJECT_SERIAL, "91" }, { PW_KEY_MEDIA_CLASS, "Stream/Output/Audio" },
                { PW_KEY_NODE_NAME, "music-output" }, { PW_KEY_CLIENT_ID, "7" },
                { "paj.voice.owner", "owner" },
            };
            if (guard == 1) { own_items[4] = SPA_DICT_ITEM_INIT(PW_KEY_APP_ID, "org.paj.voice");
                s.inherit = false; s.app = "org.paj.voice"; s.binary = ""; }
            if (guard == 2) { own_items[2].value = "paj_voice_play: stream (1)"; s.name = own_items[2].value; }
            if (guard == 3) own_items[4] = SPA_DICT_ITEM_INIT(PW_KEY_APP_NAME, "paj_voice_play: stream (1)");
            struct spa_dict own = SPA_DICT_INIT(own_items, guard == 2 ? 4 : 5); bound_info(&s, 32, &own);
        }
        done(&s); CHECK(s.failed && fake.writes == 0 && !s.success);
    }
    puts("native callbacks: explicit ALL permits anonymous/call/alert/other-TTS playback, never PiVoice/muted/new attenuation on restore");
}
static void metadata_label_before_write(struct state *s, bool associated) {
    reset_fixture(s); s->app = ""; s->binary = ""; s->role = ""; s->all = true;
    s->name = "Audio output: stream (1)";
    struct spa_dict_item node_items[] = {
        { PW_KEY_OBJECT_SERIAL, "91" }, { PW_KEY_MEDIA_CLASS, "Stream/Output/Audio" },
        { PW_KEY_NODE_NAME, s->name }, { PW_KEY_APP_NAME, "Application: playback (1)" },
        { PW_KEY_CLIENT_ID, "7" },
    };
    struct spa_dict metadata = SPA_DICT_INIT(node_items, associated ? 5 : 4);
    if (associated) {
        s->associated = true; s->inherit = true; s->client_id = 7; s->client_serial = "70";
        s->client_app = ""; s->client_binary = ""; s->client_role = "";
        s->client_name = s->name; s->client_application_name = "Application: playback (1)";
        struct spa_dict_item client_items[] = {
            { PW_KEY_OBJECT_SERIAL, "70" }, { PW_KEY_NODE_NAME, s->client_name },
            { PW_KEY_APP_NAME, s->client_application_name },
        };
        struct spa_dict client_metadata = SPA_DICT_INIT(client_items, 3);
        registry_events.global(s, 7, PW_PERM_R, PW_TYPE_INTERFACE_Client, PW_VERSION_CLIENT, &client_metadata);
        client_info_event(s, 7, &client_metadata);
    }
    registry_events.global(s, 32, PW_PERM_R | PW_PERM_W | PW_PERM_X,
        PW_TYPE_INTERFACE_Node, PW_VERSION_NODE, &metadata);
    sync_next(s); done(s); bound_info(s, 32, &metadata); done(s);
    CHECK(!s->failed && s->phase == 2); param(s, s->expected, false);
}
static void metadata_labels(void) {
    struct state s;
    for (int associated = 0; associated < 2; associated++) {
        metadata_label_before_write(&s, associated); done(&s); done(&s);
        param(&s, s.desired, false); done(&s); CHECK(s.success && fake.writes == 1);
    }
    for (int readback = 0; readback < 2; readback++) for (int field = 0; field < 3; field++) {
        metadata_label_before_write(&s, true);
        if (readback) { done(&s); done(&s); param(&s, s.desired, false); }
        if (field == 0) {
            struct spa_dict_item changed_items[] = {
                { PW_KEY_OBJECT_SERIAL, "91" }, { PW_KEY_MEDIA_CLASS, "Stream/Output/Audio" },
                { PW_KEY_NODE_NAME, "Audio output: stream (2)" }, { PW_KEY_CLIENT_ID, "7" },
            };
            struct spa_dict changed = SPA_DICT_INIT(changed_items, 4); bound_info(&s, 32, &changed);
        } else {
            struct spa_dict_item changed_items[] = {
                { PW_KEY_OBJECT_SERIAL, "70" }, { PW_KEY_NODE_NAME, field == 1 ? "Audio output: stream (2)" : s.client_name },
                { PW_KEY_APP_NAME, field == 2 ? "Application: playback (2)" : s.client_application_name },
            };
            struct spa_dict changed = SPA_DICT_INIT(changed_items, 3); client_info_event(&s, 7, &changed);
        }
        done(&s); CHECK(s.failed && !s.success && fake.writes == readback);
    }
    char oversized[258]; memset(oversized, 'a', sizeof(oversized) - 1); oversized[257] = '\0';
    const char *invalid[] = { "bad\nname", "bad\tname", "bad\x7fname", "https://example.invalid", oversized, "na\xc3\xafve" };
    for (size_t i = 0; i < SPA_N_ELEMENTS(invalid); i++) for (int field = 0; field < 4; field++) {
        metadata_label_before_write(&s, true);
        if (field == 0 || field == 3) {
            struct spa_dict_item changed_items[] = {
                { PW_KEY_OBJECT_SERIAL, "91" }, { PW_KEY_MEDIA_CLASS, "Stream/Output/Audio" },
                { PW_KEY_NODE_NAME, field == 0 ? invalid[i] : s.name }, { PW_KEY_CLIENT_ID, "7" },
                { PW_KEY_APP_NAME, field == 3 ? invalid[i] : "" },
            };
            if (field == 0) s.name = invalid[i];
            struct spa_dict changed = SPA_DICT_INIT(changed_items, 5); bound_info(&s, 32, &changed);
        } else {
            struct spa_dict_item changed_items[] = {
                { PW_KEY_OBJECT_SERIAL, "70" }, { PW_KEY_NODE_NAME, field == 1 ? invalid[i] : s.client_name },
                { PW_KEY_APP_NAME, field == 2 ? invalid[i] : s.client_application_name },
            };
            if (field == 1) s.client_name = invalid[i]; else s.client_application_name = invalid[i];
            struct spa_dict changed = SPA_DICT_INIT(changed_items, 3); client_info_event(&s, 7, &changed);
        }
        done(&s); CHECK(s.failed && !s.success && fake.writes == 0);
    }
    char maximum[257]; memset(maximum, 'a', sizeof(maximum) - 1); maximum[256] = '\0';
    metadata_label_before_write(&s, true); s.name = maximum;
    struct spa_dict_item maximum_items[] = {
        { PW_KEY_OBJECT_SERIAL, "91" }, { PW_KEY_MEDIA_CLASS, "Stream/Output/Audio" },
        { PW_KEY_NODE_NAME, maximum }, { PW_KEY_CLIENT_ID, "7" },
    };
    struct spa_dict maximum_metadata = SPA_DICT_INIT(maximum_items, 4); bound_info(&s, 32, &maximum_metadata);
    done(&s); done(&s); param(&s, s.desired, false); done(&s); CHECK(s.success && !s.failed && fake.writes == 1);
    puts("native callbacks: printable labels bind literally; changed labels fence write/readback; unsafe labels fail closed");
}
static void registry_association_authority(void) {
    struct state s;
    const char *associations[] = { "8", "", "07", "4294967296", NULL, "7" };
    for (int all = 0; all < 2; all++) for (int associated = 0; associated < 2; associated++) {
        for (size_t fault = 0; fault < SPA_N_ELEMENTS(associations); fault++) {
            if (!associated && fault == 4) continue;
            reset_fixture(&s); s.all = all;
            if (associated) {
                s.associated = true; s.client_id = 7; s.client_serial = "70";
                s.client_app = ""; s.client_binary = "helium"; s.client_role = "";
                s.client_name = ""; s.client_application_name = "";
                registry_events.global(&s, 7, PW_PERM_R, PW_TYPE_INTERFACE_Client, PW_VERSION_CLIENT, &client_props);
                client_info_event(&s, 7, &client_props); CHECK(!s.failed);
            }
            struct spa_dict_item registry_items[8]; memcpy(registry_items, items, sizeof(items));
            registry_items[6] = SPA_DICT_ITEM_INIT(PW_KEY_CLIENT_ID, associations[fault]);
            registry_items[7] = SPA_DICT_ITEM_INIT(PW_KEY_CLIENT_ID, "8");
            struct spa_dict registry_metadata = SPA_DICT_INIT(registry_items, fault == 4 ? 6 : fault == 5 ? 8 : 7);
            registry_events.global(&s, 32, PW_PERM_R | PW_PERM_W | PW_PERM_X,
                PW_TYPE_INTERFACE_Node, PW_VERSION_NODE, &registry_metadata);
            CHECK(s.failed && fake.binds == 0 && fake.writes == 0 && !s.success);
            struct spa_dict_item claimed_items[7]; memcpy(claimed_items, items, sizeof(items));
            claimed_items[6] = SPA_DICT_ITEM_INIT(PW_KEY_CLIENT_ID, "7");
            struct spa_dict claimed = SPA_DICT_INIT(claimed_items, associated ? 7 : 6);
            struct pw_node_info spoofed = { .id = 32, .change_mask = PW_NODE_CHANGE_MASK_PROPS, .props = &claimed };
            node_events.info(&s, &spoofed); sync_next(&s); done(&s);
            CHECK(s.failed && fake.binds == 0 && fake.writes == 0 && !s.success);
        }
    }
    puts("native callbacks: trusted registry association presence/ID must match expected owner before Node binding");
}
static void correlated_parameter_rounds(void) {
    struct state s;
    before_write(&s); const int initial_seq = fake.enum_seq;
    done(&s); done(&s); CHECK(s.phase == 4 && fake.writes == 1 && !s.params_ok && s.param_count == 0);
    param_request(&s, initial_seq, SPA_PARAM_Props, SPA_TYPE_OBJECT_Props, s.desired, s.mute);
    CHECK(!s.params_ok && s.param_count == 0 && !s.failed);
    done(&s); CHECK(s.failed && !s.success && fake.writes == 1);
    param(&s, s.desired, s.mute); done(&s);
    CHECK(s.failed && !s.success && fake.writes == 1 && s.param_count == 0);

    before_write(&s); const int first_seq = fake.enum_seq; done(&s);
    param_request(&s, first_seq, SPA_PARAM_Props, SPA_TYPE_OBJECT_Props, s.desired, s.mute);
    CHECK(s.phase == 3 && !s.failed);
    done(&s); const int readback_seq = fake.enum_seq;
    CHECK(readback_seq > 0 && readback_seq != first_seq && !s.params_ok && s.param_count == 0);
    param_request(&s, first_seq, SPA_PARAM_Props, SPA_TYPE_OBJECT_Props, s.desired, s.mute);
    param_request(&s, readback_seq + 1, SPA_PARAM_Props, SPA_TYPE_OBJECT_Props, s.desired, s.mute);
    param_request(&s, 0, SPA_PARAM_Props, SPA_TYPE_OBJECT_Props, s.desired, s.mute);
    param_request(&s, readback_seq, SPA_PARAM_Format, SPA_TYPE_OBJECT_Props, s.desired, s.mute);
    param_request(&s, readback_seq, SPA_PARAM_Props, SPA_TYPE_OBJECT_Format, s.desired, s.mute);
    fake.node_events->param(&s, readback_seq, SPA_PARAM_Props, 0, 0, NULL);
    uint8_t buffer[1024]; struct spa_pod_builder builder = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
    const struct spa_pod *wrong_object_id = spa_pod_builder_add_object(&builder,
        SPA_TYPE_OBJECT_Props, SPA_PARAM_Format, SPA_PROP_mute, SPA_POD_Bool(s.mute),
        SPA_PROP_channelVolumes, SPA_POD_Array(sizeof(float), SPA_TYPE_Float, 2, s.desired));
    fake.node_events->param(&s, readback_seq, SPA_PARAM_Props, 0, 0, wrong_object_id);
    CHECK(!s.failed && !s.params_ok && s.param_count == 0 && !s.success);
    param(&s, s.desired, s.mute); CHECK(s.params_ok && s.param_count == 1 && !s.success);
    param_request(&s, first_seq, SPA_PARAM_Props, SPA_TYPE_OBJECT_Props, s.expected, s.mute);
    done(&s); CHECK(s.success && !s.failed && fake.writes == 1 && s.param_count == 1);

    fixture(&s); done(&s); bound_info(&s, 32, &props); done(&s);
    param_request(&s, fake.enum_seq + 1, SPA_PARAM_Props, SPA_TYPE_OBJECT_Props, s.expected, s.mute);
    CHECK(!s.params_ok && s.param_count == 0 && !s.failed); done(&s);
    CHECK(s.failed && !s.success && fake.writes == 0);
    puts("native callbacks: only fresh current-round Props can authorize a write or its readback acknowledgement");
}
static void asynchronous_parameter_rounds(void) {
    struct state s;
    fixture(&s); done(&s); bound_info(&s, 32, &props);
    fake.enum_result = SPA_RESULT_RETURN_ASYNC(7);
    done(&s);
    CHECK(s.phase == 2 && fake.enums == 1 && fake.writes == 0);
    param_request(&s, 1, SPA_PARAM_Props, SPA_TYPE_OBJECT_Props, s.expected, s.mute);
    CHECK(!s.params_ok && s.param_count == 0 && !s.failed);
    param(&s, s.expected, s.mute);
    CHECK(s.params_ok && !s.failed);
    const int initial_seq = fake.enum_seq;
    done(&s); CHECK(s.phase == 3 && fake.writes == 1);
    fake.enum_result = SPA_RESULT_RETURN_ASYNC(11);
    done(&s); CHECK(s.phase == 4 && !s.params_ok);
    param_request(&s, initial_seq, SPA_PARAM_Props, SPA_TYPE_OBJECT_Props, s.desired, s.mute);
    CHECK(!s.params_ok && s.param_count == 0);
    param(&s, s.desired, s.mute); done(&s);
    CHECK(s.success && !s.failed && fake.writes == 1);
    puts("native callbacks: remote asynchronous enumeration result sequences fence both parameter rounds");
}
int main(void) {
    alarm(15);
    asynchronous_parameter_rounds();
    correlated_parameter_rounds();
    registry_association_authority();
    metadata_labels();
    all_other_playback();
    associated_client_sequence();
    associated_client_guards();
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

#define _GNU_SOURCE
#include <pipewire/pipewire.h>
#include <spa/param/props.h>
#include <spa/pod/builder.h>
#include <spa/pod/iter.h>
#include <sys/prctl.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHANNELS 64
struct state {
    struct pw_main_loop *loop;
    struct pw_core *core;
    struct pw_registry *registry;
    struct pw_node *node;
    struct spa_hook core_hook, registry_hook, node_hook, proxy_hook;
    uint32_t cookie, id;
    const char *serial, *app, *binary, *role, *name;
    float expected[CHANNELS], desired[CHANNELS];
    uint32_t channels;
    bool mute, restore, cookie_ok, identity_ok, params_ok, success, failed;
    int phase, pending, param_count;
};
static void fail(struct state *s) {
    s->failed = true;
    pw_main_loop_quit(s->loop);
}
static bool number(const char *str, uint64_t max, uint64_t *out) {
    if (!str || !*str || (*str == '0' && str[1])) return false;
    for (const char *p = str; *p; p++) if (*p < '0' || *p > '9') return false;
    errno = 0;
    char *end;
    unsigned long long n = strtoull(str, &end, 10);
    if (errno || *end || n > max) return false;
    *out = n;
    return true;
}
static bool parse_flag(const char *str, bool *value) {
    if (strcmp(str, "0") != 0 && strcmp(str, "1") != 0) return false;
    *value = strcmp(str, "1") == 0;
    return true;
}
static bool parse_gains(const char *str, float *values, uint32_t *count) {
    *count = 0;
    if (!str || !*str || strlen(str) > 4096) return false;
    while (*str) {
        if (*count == CHANNELS || *str == ' ' || *str == '-' || *str == '+') return false;
        char *end;
        errno = 0;
        float value = strtof(str, &end);
        if (errno || end == str || !isfinite(value) || value < 0 || value > 16) return false;
        values[(*count)++] = value;
        if (!*end) return true;
        if (*end != ',' || !end[1]) return false;
        str = end + 1;
    }
    return false;
}
static bool equal_prop(const struct spa_dict *props, const char *key, const char *value) {
    const char *actual = props ? spa_dict_lookup(props, key) : NULL;
    return actual && strcmp(actual, value) == 0;
}
static bool equal_optional_prop(const struct spa_dict *props, const char *key, const char *value) {
    const char *actual = props ? spa_dict_lookup(props, key) : NULL;
    return strcmp(actual ? actual : "", value) == 0;
}
static bool normalized_role_is(const char *role, const char *name) {
    char normalized[257];
    size_t n = 0;
    for (const unsigned char *p = (const unsigned char *)role; *p; p++) {
        unsigned char c = *p >= 'A' && *p <= 'Z' ? *p + ('a' - 'A') : *p;
        if (c >= 'a' && c <= 'z') {
            if (n == sizeof(normalized) - 1) return false;
            normalized[n++] = c;
        }
    }
    normalized[n] = '\0';
    return strcmp(normalized, name) == 0;
}
static bool protected_role(const char *role) {
    const char *roles[] = { "communication", "phone", "alert", "emergency", "notification",
        "event", "accessibility", "alarm", "ringtone", "voice" };
    for (size_t i = 0; i < SPA_N_ELEMENTS(roles); i++)
        if (normalized_role_is(role, roles[i])) return true;
    return false;
}
static bool own_stream(const char *app, const char *name, const struct spa_dict *props) {
    return strcmp(app, "org.paj.voice") == 0 || strncmp(name, "paj_voice_play", 14) == 0
        || (props && spa_dict_lookup(props, "paj.voice.owner") != NULL);
}
static bool release_gate(const struct state *s) {
    if ((protected_role(s->role) || s->mute) && !s->restore) return false;
    /* Only the trusted caller tracks ownership; cleanup may undo attenuation,
       including after a role/mute edit, but must never further attenuate. */
    if (s->restore)
        for (uint32_t i = 0; i < s->channels; i++)
            if (s->desired[i] < s->expected[i]) return false;
    return true;
}
static bool bound_identity(const struct state *s, const struct pw_node_info *info) {
    return info->id == s->id && release_gate(s)
        && !own_stream(s->app, s->name, info->props)
        && equal_prop(info->props, PW_KEY_OBJECT_SERIAL, s->serial)
        && equal_prop(info->props, PW_KEY_MEDIA_CLASS, "Stream/Output/Audio")
        && equal_optional_prop(info->props, PW_KEY_APP_ID, s->app)
        && equal_optional_prop(info->props, PW_KEY_APP_PROCESS_BINARY, s->binary)
        && equal_optional_prop(info->props, PW_KEY_MEDIA_ROLE, s->role)
        && equal_prop(info->props, PW_KEY_NODE_NAME, s->name);
}
static bool props_match(const struct spa_pod *pod, const float *values, uint32_t channels, bool mute) {
    if (!pod || !spa_pod_is_object(pod) || SPA_POD_OBJECT_TYPE(pod) != SPA_TYPE_OBJECT_Props) return false;
    const struct spa_pod_prop *p;
    int seen_mute = 0, seen_volumes = 0;
    SPA_POD_OBJECT_FOREACH((const struct spa_pod_object *)pod, p) {
        if (p->key == SPA_PROP_mute) {
            bool actual;
            if (++seen_mute != 1 || spa_pod_get_bool(&p->value, &actual) < 0 || actual != mute) return false;
        } else if (p->key == SPA_PROP_channelVolumes) {
            uint32_t n, size, type;
            const float *actual = spa_pod_get_array_full(&p->value, &n, &size, &type);
            if (++seen_volumes != 1 || !actual || size != sizeof(float) || type != SPA_TYPE_Float || n != channels) return false;
            for (uint32_t i = 0; i < n; i++)
                if (!isfinite(actual[i]) || actual[i] < 0 || actual[i] > 16
                    || fabsf(actual[i] - values[i]) > 1e-6f * fmaxf(1.0f, fmaxf(fabsf(actual[i]), fabsf(values[i])))) return false;
        }
    }
    return seen_mute == 1 && seen_volumes == 1;
}
static void node_info(void *data, const struct pw_node_info *info) {
    struct state *s = data;
    if (!(info->change_mask & PW_NODE_CHANGE_MASK_PROPS)) return;
    s->identity_ok = bound_identity(s, info);
    if (!s->identity_ok) fail(s);
}
static void node_param(void *data, int seq, uint32_t id, uint32_t index, uint32_t next, const struct spa_pod *param) {
    struct state *s = data;
    (void)seq; (void)index; (void)next;
    if (id != SPA_PARAM_Props || (s->phase != 2 && s->phase != 4)) { fail(s); return; }
    s->param_count++;
    s->params_ok = s->param_count == 1 && props_match(param,
        s->phase == 2 ? s->expected : s->desired, s->channels, s->mute);
    if (!s->params_ok) fail(s);
}
static const struct pw_node_events node_events = {
    PW_VERSION_NODE_EVENTS, .info = node_info, .param = node_param,
};
static void proxy_removed(void *data) { fail(data); }
static void proxy_error(void *data, int seq, int res, const char *message) {
    (void)seq; (void)res; (void)message; fail(data);
}
static const struct pw_proxy_events proxy_events = {
    PW_VERSION_PROXY_EVENTS, .removed = proxy_removed, .error = proxy_error,
};
static void global(void *data, uint32_t id, uint32_t permissions, const char *type,
                   uint32_t version, const struct spa_dict *props) {
    struct state *s = data;
    if (id != s->id) return;
    if (s->node || strcmp(type, PW_TYPE_INTERFACE_Node) ||
        (permissions & (PW_PERM_R | PW_PERM_W | PW_PERM_X)) != (PW_PERM_R | PW_PERM_W | PW_PERM_X) ||
        !equal_prop(props, PW_KEY_OBJECT_SERIAL, s->serial) ||
        !equal_prop(props, PW_KEY_MEDIA_CLASS, "Stream/Output/Audio")) { fail(s); return; }
    s->node = pw_registry_bind(s->registry, id, type, SPA_MIN(version, (uint32_t)PW_VERSION_NODE), 0);
    if (!s->node) { fail(s); return; }
    pw_proxy_add_listener((struct pw_proxy *)s->node, &s->proxy_hook, &proxy_events, s);
    pw_node_add_listener(s->node, &s->node_hook, &node_events, s);
}
static void global_remove(void *data, uint32_t id) {
    struct state *s = data;
    if (id == s->id) fail(s);
}
static const struct pw_registry_events registry_events = {
    PW_VERSION_REGISTRY_EVENTS, .global = global, .global_remove = global_remove,
};
static void core_info(void *data, const struct pw_core_info *info) {
    struct state *s = data;
    s->cookie_ok = info->cookie == s->cookie;
    if (!s->cookie_ok) fail(s);
}
static void sync_next(struct state *s) {
    s->pending = pw_core_sync(s->core, PW_ID_CORE, 0);
    if (s->pending < 0) fail(s);
}
static void enumerate(struct state *s, int phase) {
    s->phase = phase; s->params_ok = false; s->param_count = 0;
    if (pw_node_enum_params(s->node, 0, SPA_PARAM_Props, 0, 2, NULL) < 0) { fail(s); return; }
    sync_next(s);
}
static void core_done(void *data, uint32_t id, int seq) {
    struct state *s = data;
    if (s->failed || id != PW_ID_CORE || seq != s->pending) return;
    if (!s->cookie_ok || !s->node) { fail(s); return; }
    switch (s->phase) {
    case 0: s->phase = 1; sync_next(s); break;
    case 1:
        if (!s->identity_ok) { fail(s); return; }
        enumerate(s, 2); break;
    case 2: {
        if (!s->params_ok || !s->identity_ok) { fail(s); return; }
        uint8_t buffer[1024];
        struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
        const struct spa_pod *pod = spa_pod_builder_add_object(&b,
            SPA_TYPE_OBJECT_Props, SPA_PARAM_Props,
            SPA_PROP_channelVolumes, SPA_POD_Array(sizeof(float), SPA_TYPE_Float, s->channels, s->desired));
        /* This is a bound proxy, never a second lookup by a recyclable global ID.
           PipeWire has no atomic user-edit CAS: comparison and write are best effort. */
        if (!pod || pw_node_set_param(s->node, SPA_PARAM_Props, 0, pod) < 0) { fail(s); return; }
        s->phase = 3; sync_next(s); break;
    }
    case 3: enumerate(s, 4); break;
    case 4:
        if (!s->params_ok || !s->identity_ok) { fail(s); return; }
        s->success = true; pw_main_loop_quit(s->loop); break;
    default: fail(s);
    }
}
static void core_error(void *data, uint32_t id, int seq, int res, const char *message) {
    (void)id; (void)seq; (void)res; (void)message; fail(data);
}
static const struct pw_core_events core_events = {
    PW_VERSION_CORE_EVENTS, .info = core_info, .done = core_done, .error = core_error,
};
static void timeout_event(void *data, uint64_t expirations) { (void)expirations; fail(data); }
static int self_test(void) {
    uint8_t buffer[1024];
    struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
    float values[] = { 1.0f, 0.5f }, wrong[] = { 1.0f, 0.4f };
    float rounded[] = { 1.0000005f, 0.4999998f };
    const struct spa_pod *pod = spa_pod_builder_add_object(&b, SPA_TYPE_OBJECT_Props, SPA_PARAM_Props,
        SPA_PROP_mute, SPA_POD_Bool(false),
        SPA_PROP_channelVolumes, SPA_POD_Array(sizeof(float), SPA_TYPE_Float, 2, values));
    uint32_t n; float parsed[CHANNELS];
    struct spa_dict_item items[] = {
        { PW_KEY_OBJECT_SERIAL, "91" }, { PW_KEY_MEDIA_CLASS, "Stream/Output/Audio" },
        { PW_KEY_APP_PROCESS_BINARY, "music" }, { PW_KEY_NODE_NAME, "music-output" },
        { PW_KEY_APP_ID, "org.example.changed" }, { "paj.voice.owner", "owner-1" },
    };
    struct spa_dict dict = SPA_DICT_INIT(items, 4);
    struct state expected = { .id = 32, .serial = "91", .app = "", .binary = "music",
        .role = "", .name = "music-output" };
    struct pw_node_info info = { .id = 32, .props = &dict };
    if (!bound_identity(&expected, &info)) return 1;
    dict.n_items = 5;
    if (bound_identity(&expected, &info)) return 1;
    items[4].value = "";
    if (!bound_identity(&expected, &info)) return 1;
    dict.n_items = 6;
    if (bound_identity(&expected, &info)) return 1;
    dict.n_items = 4;
    info.id = 33;
    if (bound_identity(&expected, &info)) return 1;
    info.id = 32; items[0].value = "92";
    if (bound_identity(&expected, &info)) return 1;
    items[0].value = "91"; items[1].value = "Audio/Sink";
    if (bound_identity(&expected, &info)) return 1;
    items[1].value = "Stream/Output/Audio"; items[3].value = "paj_voice_play-extra";
    expected.name = items[3].value;
    if (bound_identity(&expected, &info)) return 1;
    expected.name = "music-output"; items[3].value = expected.name;
    items[4].key = PW_KEY_MEDIA_ROLE; items[4].value = "Communication";
    dict.n_items = 5; expected.role = "Communication"; expected.channels = 2;
    expected.expected[0] = 0.2f; expected.expected[1] = 0.1f;
    expected.desired[0] = 1.0f; expected.desired[1] = 0.5f;
    if (release_gate(&expected) || bound_identity(&expected, &info)) return 1;
    expected.restore = true;
    if (!release_gate(&expected) || !bound_identity(&expected, &info)) return 1;
    expected.desired[1] = 0.05f;
    if (release_gate(&expected) || bound_identity(&expected, &info)) return 1;
    expected.desired[1] = 0.5f; expected.mute = true;
    if (!release_gate(&expected) || !bound_identity(&expected, &info)) return 1;
    expected.restore = false;
    if (release_gate(&expected)) return 1;
    expected.restore = true;
    expected.role = "V.o.i.c.e"; items[4].value = expected.role;
    if (!release_gate(&expected) || !bound_identity(&expected, &info)) return 1;
    expected.restore = false;
    if (release_gate(&expected) || bound_identity(&expected, &info)) return 1;
    expected.restore = true; expected.desired[1] = 0.05f;
    if (release_gate(&expected) || bound_identity(&expected, &info)) return 1;
    expected.desired[1] = 0.5f;
    expected.role = "Communication"; items[4].value = expected.role; dict.n_items = 6;
    if (bound_identity(&expected, &info)) return 1;
    dict.n_items = 5; items[1].value = "Audio/Sink";
    if (bound_identity(&expected, &info)) return 1;
    bool flag;
    if (!parse_flag("0", &flag) || flag || !parse_flag("1", &flag) || !flag
        || parse_flag("true", &flag) || parse_flag("01", &flag) || parse_flag("", &flag)) return 1;
    return props_match(pod, values, 2, false) && props_match(pod, rounded, 2, false)
        && !props_match(pod, wrong, 2, false)
        && !props_match(pod, values, 1, false) && !props_match(pod, values, 2, true)
        && parse_gains("1,0.5", parsed, &n) && n == 2
        && !parse_gains("nan", parsed, &n) && !parse_gains("1,", parsed, &n)
        && protected_role("V.o.i.c.e") && protected_role("communication")
        && protected_role("Ring-tone") && protected_role("ALERT")
        && protected_role("Emergency") && protected_role("event")
        && !protected_role("Production") && !protected_role("") ? 0 : 1;
}
static bool install_parent_guard(void) {
    const pid_t parent = getppid();
    return parent != 1 && prctl(PR_SET_PDEATHSIG, SIGKILL) == 0 && getppid() == parent;
}
int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "--self-test") == 0) return self_test();
    if (!install_parent_guard()) return 1;
    if (argc != 12) return 1;
    struct state s = {0};
    uint64_t cookie, id, serial_number;
    uint32_t count;
    if (!number(argv[1], UINT32_MAX, &cookie) || !number(argv[2], UINT64_MAX, &serial_number)
        || !number(argv[3], UINT32_MAX, &id)
        || !parse_flag(argv[8], &s.mute) || !parse_flag(argv[11], &s.restore)
        || !parse_gains(argv[9], s.expected, &s.channels)
        || !parse_gains(argv[10], s.desired, &count) || count != s.channels) return 1;
    for (int i = 4; i <= 7; i++) if (strlen(argv[i]) > 256) return 1;
    if ((!*argv[4] && !*argv[5]) || !*argv[7] || own_stream(argv[4], argv[7], NULL)) return 1;
    s.cookie = cookie; s.id = id; s.serial = argv[2]; s.app = argv[4];
    s.binary = argv[5]; s.role = argv[6]; s.name = argv[7];
    if (!release_gate(&s)) return 1;
    pw_init(NULL, NULL);
    s.loop = pw_main_loop_new(NULL);
    if (!s.loop) return 1;
    struct pw_context *context = pw_context_new(pw_main_loop_get_loop(s.loop), NULL, 0);
    if (!context) { pw_main_loop_destroy(s.loop); return 1; }
    s.core = pw_context_connect(context, pw_properties_new(PW_KEY_APP_NAME, "paj-voice-focus-control", NULL), 0);
    if (!s.core) { pw_context_destroy(context); pw_main_loop_destroy(s.loop); return 1; }
    pw_core_add_listener(s.core, &s.core_hook, &core_events, &s);
    s.registry = pw_core_get_registry(s.core, PW_VERSION_REGISTRY, 0);
    if (!s.registry) { pw_core_disconnect(s.core); pw_context_destroy(context); pw_main_loop_destroy(s.loop); return 1; }
    pw_registry_add_listener(s.registry, &s.registry_hook, &registry_events, &s);
    struct spa_source *timer = pw_loop_add_timer(pw_main_loop_get_loop(s.loop), timeout_event, &s);
    if (!timer) return 1;
    struct timespec duration = { .tv_sec = 1, .tv_nsec = 400000000 };
    pw_loop_update_timer(pw_main_loop_get_loop(s.loop), timer, &duration, NULL, false);
    sync_next(&s);
    if (!s.failed) pw_main_loop_run(s.loop);
    pw_loop_destroy_source(pw_main_loop_get_loop(s.loop), timer);
    if (s.node) pw_proxy_destroy((struct pw_proxy *)s.node);
    pw_proxy_destroy((struct pw_proxy *)s.registry);
    pw_core_disconnect(s.core);
    pw_context_destroy(context);
    pw_main_loop_destroy(s.loop);
    pw_deinit();
    if (s.success && !s.failed) { puts("ok"); return 0; }
    return 1;
}

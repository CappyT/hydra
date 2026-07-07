import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildSandboxEnv } from "./sandbox-env.ts";

describe("buildSandboxEnv", () => {
  it("drops secret-looking variables the game never needs", () => {
    const result = buildSandboxEnv({
      AWS_SECRET_ACCESS_KEY: "super-secret",
      GITHUB_TOKEN: "ghp_deadbeef",
      OPENAI_API_KEY: "sk-123",
      SSH_AUTH_SOCK: "/run/user/1000/keyring/ssh",
    });

    assert.deepEqual(result, {});
  });

  it("keeps the allowlisted exact keys", () => {
    const base = {
      HOME: "/home/tester",
      USER: "tester",
      LOGNAME: "tester",
      SHELL: "/bin/bash",
      PATH: "/usr/bin",
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      PWD: "/home/tester",
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-0",
      XAUTHORITY: "/home/tester/.Xauthority",
      XDG_RUNTIME_DIR: "/run/user/1000",
      XDG_DATA_HOME: "/home/tester/.local/share",
      XDG_CONFIG_HOME: "/home/tester/.config",
      XDG_CACHE_HOME: "/home/tester/.cache",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    };

    assert.deepEqual(buildSandboxEnv(base), base);
  });

  it("keeps variables matching an allowlisted prefix family", () => {
    const base = {
      LC_ALL: "en_US.UTF-8",
      WINEPREFIX: "/prefix",
      WINEDEBUG: "-all",
      PROTON_LOG: "1",
      STEAM_COMPAT_DATA_PATH: "/prefix",
      UMU_NO_RUNTIME: "1",
      DXVK_HUD: "fps",
      VKD3D_CONFIG: "dxr",
      MANGOHUD: "1",
      GAMESCOPE_WIDTH: "1920",
      GAMEID: "umu-123",
      SDL_VIDEODRIVER: "wayland",
      PULSE_SERVER: "unix:/run/user/1000/pulse/native",
      PIPEWIRE_LATENCY: "512/48000",
      VK_ICD_FILENAMES: "/usr/share/vulkan/icd.d/nvidia.json",
      VULKAN_SDK: "/usr",
      MESA_GL_VERSION_OVERRIDE: "4.6",
      DRI_PRIME: "1",
      LIBGL_ALWAYS_SOFTWARE: "0",
      __GL_SHADER_DISK_CACHE: "1",
      __NV_PRIME_RENDER_OFFLOAD: "1",
      __VK_LAYER_NV_optimus: "NVIDIA_only",
      NV_PRIME_RENDER_OFFLOAD: "1",
      NVIDIA_DRIVER_CAPABILITIES: "all",
      RADV_PERFTEST: "gpl",
      AMD_VULKAN_ICD: "RADV",
      ACO_DEBUG: "validateir",
      GALLIUM_DRIVER: "zink",
      WAYLAND_DISPLAY: "wayland-0",
      GDK_BACKEND: "wayland",
      QT_QPA_PLATFORM: "wayland",
      FREETYPE_PROPERTIES: "truetype:interpreter-version=40",
      FONTCONFIG_PATH: "/etc/fonts",
      ENABLE_VKBASALT: "1",
      DISABLE_LAYER_NV_OPTIMUS_1: "1",
      HYDRA_UMU_PYTHON: "/usr/bin/python3",
    };

    assert.deepEqual(buildSandboxEnv(base), base);
  });

  it("lets launch-style keys survive so the spawn merge keeps them", () => {
    // The spawn sites merge the launch's explicit env on top of the scrubbed
    // base; this asserts those keys are not dropped by the base scrub itself.
    const result = buildSandboxEnv({
      WINEPREFIX: "/prefix",
      PROTONPATH: "/proton",
      GAMEID: "umu-123",
      SECRET_TOKEN: "nope",
    });

    assert.deepEqual(result, {
      WINEPREFIX: "/prefix",
      PROTONPATH: "/proton",
      GAMEID: "umu-123",
    });
  });

  it("drops undefined values", () => {
    const result = buildSandboxEnv({ HOME: undefined, PATH: "/usr/bin" });

    assert.deepEqual(result, { PATH: "/usr/bin" });
  });
});

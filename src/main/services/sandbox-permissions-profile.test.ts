import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { FILTERED_PULSE_CONFIG } from "./sandbox-audio.ts";
import {
  buildSandboxArgs,
  NETWORK_ISOLATION_WRAPPER,
} from "./sandbox-command-builder.ts";
import { isCameraProperties } from "./sandbox-input.ts";

const binds = (args: string[]) => {
  const pairs: { flag: string; source: string; dest: string }[] = [];
  args.forEach((flag, index) => {
    if (["--bind", "--ro-bind", "--dev-bind"].includes(flag)) {
      pairs.push({ flag, source: args[index + 1], dest: args[index + 2] });
    }
  });
  return pairs;
};

const setenv = (args: string[], name: string): string | undefined => {
  const index = args.findIndex(
    (arg, at) => arg === "--setenv" && args[at + 1] === name
  );
  return index < 0 ? undefined : args[index + 2];
};

describe("sandbox permission binds", () => {
  let root: string;
  let runtimeDir: string;
  let gameDir: string;
  let filteredSocket: string;
  let env: Record<string, string>;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-permissions-"));
    runtimeDir = path.join(root, "runtime");
    gameDir = path.join(root, "game");
    filteredSocket = path.join(root, "audio", "native");
    for (const file of [
      path.join(runtimeDir, "pipewire-0"),
      path.join(runtimeDir, "pipewire-0-manager"),
      path.join(runtimeDir, "pulse", "native"),
      path.join(runtimeDir, "wayland-0"),
      filteredSocket,
    ]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "");
    }
    fs.mkdirSync(gameDir);
    env = {
      HOME: path.join(root, "home"),
      XDG_RUNTIME_DIR: runtimeDir,
      WAYLAND_DISPLAY: "wayland-0",
    };
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  const build = (extra: Record<string, unknown> = {}) =>
    buildSandboxArgs({
      command: "/usr/bin/game",
      args: [],
      env,
      gameDir,
      ...extra,
    }).args;

  it("binds no audio socket unless the profile asks for one", () => {
    const pairs = binds(build());
    assert.ok(pairs.some((pair) => pair.dest.endsWith("wayland-0")));
    assert.ok(
      !pairs.some((pair) => /pipewire|pulse/.test(pair.source + pair.dest))
    );
  });

  it("binds the filtered socket at the PulseAudio path, never PipeWire", () => {
    const pairs = binds(build({ audio: { pulseSocket: filteredSocket } }));
    assert.deepEqual(
      pairs.filter((pair) => /pipewire|pulse/.test(pair.dest)),
      [
        {
          flag: "--ro-bind",
          source: filteredSocket,
          dest: path.join(runtimeDir, "pulse", "native"),
        },
      ]
    );
  });

  it("binds only the session PulseAudio socket for the microphone alone", () => {
    const pairs = binds(build({ audio: { hostSockets: "pulse" } }));
    const pulse = path.join(runtimeDir, "pulse", "native");
    assert.ok(
      pairs.some((pair) => pair.source === pulse && pair.dest === pulse)
    );
    assert.ok(!pairs.some((pair) => pair.dest.includes("pipewire")));
  });

  it("adds the session PipeWire socket only when asked for all sockets", () => {
    const pairs = binds(build({ audio: { hostSockets: "all" } }));
    for (const socket of ["pipewire-0", "pulse/native"]) {
      const target = path.join(runtimeDir, socket);
      assert.ok(
        pairs.some((pair) => pair.source === target && pair.dest === target),
        socket
      );
    }
    assert.ok(!pairs.some((pair) => pair.dest.endsWith("pipewire-0-manager")));
  });

  it("binds camera nodes only when they are listed", () => {
    assert.ok(!build().some((arg) => arg.startsWith("/dev/video")));
    assert.ok(
      binds(build({ cameraDevices: ["/dev/video0"] })).some(
        (pair) =>
          pair.flag === "--dev-bind" &&
          pair.source === "/dev/video0" &&
          pair.dest === "/dev/video0"
      )
    );
  });

  it("hands the egress policy to the wrapper through the environment", () => {
    const egress = {
      nftPath: "/usr/sbin/nft",
      nftRuleset: "table inet hydra_egress { }\n",
      ipPath: "/usr/sbin/ip",
      ipCommands: [
        ["rule", "add", "priority", "200", "to", "10.0.0.0/8", "prohibit"],
        ["-6", "rule", "add", "priority", "200", "to", "fc00::/7", "prohibit"],
      ],
    };
    const args = build({
      networkIsolation: { pastaPath: "/usr/bin/pasta", egress },
    });
    assert.equal(setenv(args, "HYDRA_EGRESS"), "1");
    assert.equal(setenv(args, "HYDRA_EGRESS_NFT_BIN"), egress.nftPath);
    assert.equal(setenv(args, "HYDRA_EGRESS_NFT_RULES"), egress.nftRuleset);
    assert.equal(
      setenv(args, "HYDRA_EGRESS_IP_RULES"),
      "rule add priority 200 to 10.0.0.0/8 prohibit\n" +
        "-6 rule add priority 200 to fc00::/7 prohibit"
    );
    // Nothing of the policy is interpolated into the script text.
    assert.ok(!NETWORK_ISOLATION_WRAPPER.includes("10.0.0.0/8"));

    const without = build({
      networkIsolation: { pastaPath: "/usr/bin/pasta" },
    });
    assert.equal(setenv(without, "HYDRA_EGRESS"), undefined);
  });
});

describe("network wrapper egress step", () => {
  const order = (needle: string) => NETWORK_ISOLATION_WRAPPER.indexOf(needle);

  it("applies the policy after pasta is ready and before the game starts", () => {
    const apply = order("_apply_egress || _fail_closed");
    assert.ok(apply > order("pasta exited during setup"));
    assert.ok(apply < order("/usr/bin/setpriv --inh-caps=-all"));
  });

  it("refuses the game when the policy cannot be applied", () => {
    assert.match(
      NETWORK_ISOLATION_WRAPPER,
      /_apply_egress \|\| _fail_closed "cannot apply the egress policy"/
    );
  });

  it("drops the setup variables and pathname expansion before the game", () => {
    assert.ok(order("set -f") < order("_host_netns="));
    const unset = order("unset HYDRA_PASTA_BIN");
    assert.ok(unset > 0 && unset < order("/usr/bin/setpriv --inh-caps=-all"));
    for (const name of [
      "HYDRA_EGRESS_NFT_RULES",
      "HYDRA_EGRESS_IP_RULES",
      "HYDRA_PASTA_DNS_HOST",
    ]) {
      assert.ok(
        NETWORK_ISOLATION_WRAPPER.slice(unset).includes(name),
        `${name} is not unset`
      );
    }
  });
});

describe("filtered PulseAudio configuration", () => {
  it("blocks capture for every client and refuses module loading", () => {
    assert.match(FILTERED_PULSE_CONFIG, /pulse\.allow-module-loading = false/);
    assert.match(FILTERED_PULSE_CONFIG, /block-record-stream/);
    // The three clauses cover a present, a different and an absent value, so
    // a client cannot leave the rule by sending its own properties.
    for (const clause of [
      '{ client.api = "pipewire-pulse" }',
      '{ client.api = "!pipewire-pulse" }',
      "{ client.api = null }",
    ]) {
      assert.ok(FILTERED_PULSE_CONFIG.includes(clause), clause);
    }
    assert.doesNotMatch(FILTERED_PULSE_CONFIG, /tcp:|pulse\.cmd/);
  });
});

describe("camera device classification", () => {
  it("accepts only nodes udev marks as capture devices", () => {
    assert.equal(
      isCameraProperties("E:ID_V4L_CAPABILITIES=:capture:\nE:ID_V4L_VERSION=2"),
      true
    );
    for (const properties of [
      "",
      "E:ID_V4L_CAPABILITIES=:",
      "E:ID_V4L_CAPABILITIES=:video_output:",
      "E:ID_INPUT_JOYSTICK=1",
    ]) {
      assert.equal(isCameraProperties(properties), false);
    }
  });
});

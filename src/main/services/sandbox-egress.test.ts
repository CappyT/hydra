import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildEgressPolicy,
  parseHostAddresses,
  parseRouteSubnets,
  subnetOf,
} from "./sandbox-egress.ts";

const IP_ADDR_JSON = JSON.stringify([
  {
    ifname: "lo",
    addr_info: [
      { family: "inet", local: "127.0.0.1", prefixlen: 8, scope: "host" },
      { family: "inet6", local: "::1", prefixlen: 128, scope: "host" },
    ],
  },
  {
    ifname: "wlp1s0",
    addr_info: [
      { family: "inet", local: "192.168.5.96", prefixlen: 24, scope: "global" },
      {
        family: "inet6",
        local: "2a0d:b280:8039:0:f91d:21a1:dd70:92ab",
        prefixlen: 64,
        scope: "global",
      },
      { family: "inet6", local: "fe80::c3fc:c261:36c1:6c84", prefixlen: 64 },
    ],
  },
  // An interface that is down still owns its address.
  {
    ifname: "docker0",
    flags: ["NO-CARRIER"],
    addr_info: [{ family: "inet", local: "172.17.0.1", prefixlen: 16 }],
  },
  {
    ifname: "bad",
    addr_info: [
      { family: "inet", local: "not-an-ip", prefixlen: 24 },
      { family: "inet", local: "10.0.0.1", prefixlen: 99 },
      { family: "inet6", local: "fe80::1%eth0", prefixlen: 64 },
      { family: "inet", local: "10.0.0.2; reject", prefixlen: 8 },
    ],
  },
]);

describe("parseHostAddresses", () => {
  it("keeps every non-loopback address, down interfaces included", () => {
    assert.deepEqual(
      parseHostAddresses(IP_ADDR_JSON)?.map((entry) => entry.address),
      [
        "192.168.5.96",
        "2a0d:b280:8039:0:f91d:21a1:dd70:92ab",
        "fe80::c3fc:c261:36c1:6c84",
        "172.17.0.1",
      ]
    );
  });

  it("drops malformed entries of a valid list", () => {
    for (const input of ["[]", "[1, null]", '[{"addr_info": 3}]']) {
      assert.deepEqual(parseHostAddresses(input), []);
    }
  });

  it("returns null, not an empty host set, for output it cannot read", () => {
    for (const input of ["", "{}", "not json", '"text"']) {
      assert.equal(parseHostAddresses(input), null);
    }
  });
});

describe("parseRouteSubnets", () => {
  it("keeps every network the host routes, except the default route", () => {
    const routes = JSON.stringify([
      { dst: "default", gateway: "192.168.5.1", dev: "wlp1s0" },
      { dst: "192.168.5.0/24", dev: "wlp1s0", scope: "link" },
      { dst: "10.8.0.0/24", gateway: "10.8.0.1", dev: "tun0" },
      // DHCPv6: the address is a /128 and the LAN prefix is only this route.
      { dst: "2a0d:b280:8039::/64", dev: "wlp1s0", protocol: "ra" },
      { dst: "203.0.113.7", gateway: "192.168.5.1", dev: "wlp1s0" },
      { dst: "::1", dev: "lo" },
      { dst: "0.0.0.0/1", dev: "tun0" },
      { dst: "2000::/3", dev: "tun0" },
      { dst: "10.9.0.0/16", type: "blackhole" },
      { dst: "bogus/24", dev: "wlp1s0" },
      { dst: "10.1.0.0/99", dev: "wlp1s0" },
      null,
    ]);
    assert.deepEqual(parseRouteSubnets(routes), [
      "192.168.5.0/24",
      "10.8.0.0/24",
      "2a0d:b280:8039:0:0:0:0:0/64",
      "203.0.113.7/32",
    ]);
  });

  it("returns null for output it cannot read", () => {
    for (const input of ["", "{}", "not json"]) {
      assert.equal(parseRouteSubnets(input), null);
    }
  });
});

describe("subnetOf", () => {
  it("masks the address to its network", () => {
    assert.equal(
      subnetOf({ family: 4, address: "192.168.5.96", prefixLength: 24 }),
      "192.168.5.0/24"
    );
    assert.equal(
      subnetOf({ family: 4, address: "100.70.200.9", prefixLength: 10 }),
      "100.64.0.0/10"
    );
    assert.equal(
      subnetOf({
        family: 6,
        address: "2a0d:b280:8039:0:f91d:21a1:dd70:92ab",
        prefixLength: 64,
      }),
      "2a0d:b280:8039:0:0:0:0:0/64"
    );
    assert.equal(
      subnetOf({ family: 6, address: "fd00::1", prefixLength: 48 }),
      "fd00:0:0:0:0:0:0:0/48"
    );
  });

  it("refuses a prefix too short to be a local network", () => {
    assert.equal(
      subnetOf({ family: 4, address: "1.2.3.4", prefixLength: 0 }),
      null
    );
    assert.equal(
      subnetOf({ family: 6, address: "2a0d::1", prefixLength: 8 }),
      null
    );
  });
});

describe("buildEgressPolicy", () => {
  const hostAddresses = parseHostAddresses(IP_ADDR_JSON) ?? [];

  it("rejects routed networks only without the permission", () => {
    const routedSubnets = ["203.0.113.0/24", "2001:db8:0:0:0:0:0:0/48"];
    const denied = buildEgressPolicy({
      hostAddresses,
      routedSubnets,
      allowLocalNetwork: false,
    });
    assert.ok(denied.nftRuleset.includes("ip daddr 203.0.113.0/24 reject"));
    assert.ok(
      denied.nftRuleset.includes("ip6 daddr 2001:db8:0:0:0:0:0:0/48 reject")
    );
    const allowed = buildEgressPolicy({
      hostAddresses,
      routedSubnets,
      allowLocalNetwork: true,
    });
    assert.doesNotMatch(allowed.nftRuleset, /203\.0\.113\.0|2001:db8/);
  });

  it("always rejects the host addresses and keeps DNS reachable", () => {
    for (const allowLocalNetwork of [true, false]) {
      const { nftRuleset, ipCommands } = buildEgressPolicy({
        hostAddresses,
        allowLocalNetwork,
        dnsForwardAddress: "169.254.1.1",
      });
      for (const rule of [
        "ip daddr 172.17.0.1/32 reject",
        "ip daddr 192.168.5.96/32 reject",
        "ip6 daddr fe80::c3fc:c261:36c1:6c84/128 reject",
        "ip daddr 169.254.1.1 udp dport 53 accept",
        "ip daddr 169.254.1.1 tcp dport 53 accept",
      ]) {
        assert.ok(nftRuleset.includes(rule), `${rule} (${allowLocalNetwork})`);
      }
      const lines = ipCommands.map((command) => command.join(" "));
      assert.ok(
        lines.includes("rule add priority 200 to 172.17.0.1/32 prohibit")
      );
      assert.ok(
        lines.includes(
          "-6 rule add priority 200 to fe80::c3fc:c261:36c1:6c84/128 prohibit"
        )
      );
      assert.ok(
        lines.includes(
          "rule add priority 100 to 169.254.1.1/32 ipproto udp dport 53 lookup main"
        )
      );
    }
  });

  it("rejects private ranges and attached subnets without the permission", () => {
    const denied = buildEgressPolicy({
      hostAddresses,
      allowLocalNetwork: false,
    });
    for (const network of [
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "169.254.0.0/16",
      "100.64.0.0/10",
      "224.0.0.0/4",
    ]) {
      assert.ok(denied.nftRuleset.includes(`ip daddr ${network} reject`));
    }
    for (const network of [
      "fc00::/7",
      "fe80::/10",
      "ff00::/8",
      // The global prefix of the LAN: its devices have routable addresses.
      "2a0d:b280:8039:0:0:0:0:0/64",
    ]) {
      assert.ok(denied.nftRuleset.includes(`ip6 daddr ${network} reject`));
    }

    const allowed = buildEgressPolicy({
      hostAddresses,
      allowLocalNetwork: true,
    });
    assert.doesNotMatch(allowed.nftRuleset, /192\.168\.0\.0\/16|fc00::\/7/);
    assert.doesNotMatch(allowed.nftRuleset, /2a0d:b280:8039:0:0:0:0:0\/64/);
  });

  it("accepts loopback and neighbour discovery before any reject", () => {
    const { nftRuleset } = buildEgressPolicy({
      hostAddresses,
      allowLocalNetwork: false,
      dnsForwardAddress: "169.254.1.1",
    });
    const firstReject = nftRuleset.indexOf(" reject");
    for (const accept of [
      'oifname "lo" accept',
      "nd-neighbor-solicit",
      "dport 53 accept",
    ]) {
      const at = nftRuleset.indexOf(accept);
      assert.ok(at > 0 && at < firstReject, accept);
    }
  });

  it("emits only words the wrapper can split safely", () => {
    const { ipCommands } = buildEgressPolicy({
      hostAddresses,
      allowLocalNetwork: false,
      dnsForwardAddress: "169.254.1.1",
    });
    for (const word of ipCommands.flat()) {
      assert.match(word, /^[A-Za-z0-9.:/-]+$/);
    }
  });

  it("ignores a DNS forward address that is not IPv4", () => {
    const { nftRuleset, ipCommands } = buildEgressPolicy({
      hostAddresses: [],
      allowLocalNetwork: true,
      dnsForwardAddress: "x; flush ruleset",
    });
    assert.doesNotMatch(nftRuleset, /dport 53|flush/);
    assert.deepEqual(ipCommands, []);
  });
});

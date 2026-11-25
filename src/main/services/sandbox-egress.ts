/**
 * Egress policy of the isolated game network namespace.
 *
 * pasta forwards every connection of the game from the host network namespace.
 * A destination that is local to the host (the address of a container bridge,
 * a VPN interface, the IPv6 link-local address) therefore reaches the host
 * services that listen on a wildcard address, and every LAN device is one hop
 * away. The policy runs inside the game's namespace, where the game holds no
 * capability, and rejects:
 *   - always: every address of the host;
 *   - unless the game has the local-network permission: the private,
 *     link-local and multicast ranges, the subnets the host is attached to and
 *     every network it routes apart from the default route.
 * The DNS forward address stays reachable on port 53.
 *
 * Two renderings of the same policy: an nftables ruleset (complete), and
 * `ip rule` commands for hosts without nft. The fallback does not stop a
 * multicast datagram sent on a socket bound to the interface.
 *
 * Pure and electron-free so the generated text is unit-testable.
 */
import { isIP } from "node:net";

export interface HostAddress {
  family: 4 | 6;
  address: string;
  prefixLength: number;
}

export interface EgressPolicyInput {
  hostAddresses: HostAddress[];
  /** Networks the host routes itself, from {@link parseRouteSubnets}. */
  routedSubnets?: string[];
  allowLocalNetwork: boolean;
  /** Address the sandbox resolv.conf points at; only port 53 stays open. */
  dnsForwardAddress?: string;
}

export interface EgressPolicy {
  nftRuleset: string;
  /** One `ip` invocation per entry, as an argument list. */
  ipCommands: string[][];
}

const LOCAL_NETWORKS_V4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

const LOCAL_NETWORKS_V6 = ["fc00::/7", "fe80::/10", "ff00::/8"];

/** Shorter prefixes are not a LAN: they would block most of the Internet. */
const MIN_SUBNET_PREFIX = { 4: 8, 6: 16 } as const;

const parseArray = (json: string): unknown[] | null => {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
};

/**
 * Reads the addresses out of `ip -j addr show`. Loopback is left out: inside
 * the sandbox it is the game's own interface. Malformed entries are dropped.
 * Returns null when the output is not the expected list: the caller must not
 * launch with an empty host set it did not read.
 */
export const parseHostAddresses = (json: string): HostAddress[] | null => {
  const interfaces = parseArray(json);
  if (!interfaces) return null;

  const addresses: HostAddress[] = [];
  for (const entry of interfaces) {
    const info = (entry as { addr_info?: unknown })?.addr_info;
    if (!Array.isArray(info)) continue;
    for (const item of info) {
      const { local, prefixlen, scope } = item as Record<string, unknown>;
      if (typeof local !== "string" || scope === "host") continue;
      const family = isIP(local) as 0 | 4 | 6;
      const maxPrefix = family === 4 ? 32 : 128;
      if (family === 0 || local.includes("%")) continue;
      if (
        typeof prefixlen !== "number" ||
        !Number.isInteger(prefixlen) ||
        prefixlen < 0 ||
        prefixlen > maxPrefix
      )
        continue;
      addresses.push({ family, address: local, prefixLength: prefixlen });
    }
  }
  return addresses;
};

const ipv6Groups = (address: string): number[] => {
  const [head, tail] = address.split("::");
  const parse = (part: string | undefined) =>
    part ? part.split(":").map((group) => Number.parseInt(group, 16)) : [];
  const left = parse(head);
  const right = parse(tail);
  const middle = address.includes("::")
    ? new Array(8 - left.length - right.length).fill(0)
    : [];
  return [...left, ...middle, ...right];
};

/** Network of an interface address, or null when it is not a usable subnet. */
export const subnetOf = ({
  family,
  address,
  prefixLength,
}: HostAddress): string | null => {
  const width = family === 4 ? 8 : 16;
  const count = family === 4 ? 4 : 8;
  if (prefixLength < MIN_SUBNET_PREFIX[family]) return null;
  // An embedded IPv4 tail (`::ffff:1.2.3.4`) is not an interface subnet.
  if (family === 6 && address.includes(".")) return null;

  const groups =
    family === 4 ? address.split(".").map(Number) : ipv6Groups(address);
  if (groups.length !== count || groups.some((group) => Number.isNaN(group)))
    return null;

  const masked = groups.map((group, index) => {
    const bits = Math.min(Math.max(prefixLength - index * width, 0), width);
    return group & (((1 << bits) - 1) << (width - bits));
  });
  const text =
    family === 4
      ? masked.join(".")
      : masked.map((group) => group.toString(16)).join(":");
  return `${text}/${prefixLength}`;
};

/**
 * Reads the networks out of `ip -j route show` (either family): every route
 * but the default one. An on-link prefix that is only a route (DHCPv6 gives the
 * host a /128) and a network behind a VPN are local networks too. Returns null
 * when the output is not the expected list.
 */
export const parseRouteSubnets = (json: string): string[] | null => {
  const routes = parseArray(json);
  if (!routes) return null;

  return routes.flatMap((route) => {
    const { dst, type, dev } = (route ?? {}) as Record<string, unknown>;
    if (
      typeof dst !== "string" ||
      dev === "lo" ||
      (type !== undefined && type !== "unicast")
    )
      return [];
    const [address, length] = dst.split("/");
    const family = isIP(address) as 0 | 4 | 6;
    if (family === 0 || address.includes("%")) return [];
    const prefixLength =
      length === undefined ? (family === 4 ? 32 : 128) : Number(length);
    if (
      !Number.isInteger(prefixLength) ||
      prefixLength > (family === 4 ? 32 : 128)
    )
      return [];
    const subnet = subnetOf({ family, address, prefixLength });
    return subnet ? [subnet] : [];
  });
};

const unique = (values: string[]): string[] => [...new Set(values)];

export const buildEgressPolicy = ({
  hostAddresses,
  routedSubnets = [],
  allowLocalNetwork,
  dnsForwardAddress,
}: EgressPolicyInput): EgressPolicy => {
  const blocked = (family: 4 | 6): string[] => {
    const own = hostAddresses.filter((entry) => entry.family === family);
    const hosts = own.map(
      (entry) => `${entry.address}/${family === 4 ? 32 : 128}`
    );
    if (allowLocalNetwork) return unique(hosts);
    const subnets = own
      .map(subnetOf)
      .filter((subnet): subnet is string => subnet !== null);
    return unique([
      ...hosts,
      ...(family === 4 ? LOCAL_NETWORKS_V4 : LOCAL_NETWORKS_V6),
      ...subnets,
      ...routedSubnets.filter(
        (subnet) => subnet.includes(":") === (family === 6)
      ),
    ]);
  };
  const blockedV4 = blocked(4);
  const blockedV6 = blocked(6);
  const dns =
    dnsForwardAddress && isIP(dnsForwardAddress) === 4
      ? dnsForwardAddress
      : null;

  const nftRuleset = [
    "table inet hydra_egress {",
    "  chain output {",
    "    type filter hook output priority 0; policy accept;",
    '    oifname "lo" accept',
    ...(dns
      ? [
          `    ip daddr ${dns} udp dport 53 accept`,
          `    ip daddr ${dns} tcp dport 53 accept`,
        ]
      : []),
    // Neighbour discovery must survive the link-local and multicast rejects.
    "    icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-solicit } accept",
    ...blockedV4.map((network) => `    ip daddr ${network} reject`),
    ...blockedV6.map((network) => `    ip6 daddr ${network} reject`),
    "  }",
    "}",
    "",
  ].join("\n");

  const ipCommands: string[][] = [
    ...(dns
      ? ["udp", "tcp"].map((protocol, index) => [
          "rule",
          "add",
          "priority",
          String(100 + index),
          "to",
          `${dns}/32`,
          "ipproto",
          protocol,
          "dport",
          "53",
          "lookup",
          "main",
        ])
      : []),
    ...blockedV4.map((network) => [
      "rule",
      "add",
      "priority",
      "200",
      "to",
      network,
      "prohibit",
    ]),
    ...blockedV6.map((network) => [
      "-6",
      "rule",
      "add",
      "priority",
      "200",
      "to",
      network,
      "prohibit",
    ]),
  ];

  return { nftRuleset, ipCommands };
};

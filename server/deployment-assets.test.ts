import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const asset = (name: string) => readFileSync(new URL(`../deploy/razer-remote/${name}`, import.meta.url), "utf8");

describe("Razer hostile-provider deployment assets", () => {
  it("keeps bounded VM storage root modes and production paths identical", () => {
    const setup = asset("openmaus-storage-setup");
    const leaf = asset("openmaus-storage-leaf");
    const service = asset("openmausbot.service");
    expect(setup).toMatch(/"\/var\/lib\/openmausbot-vm-homes"[\s\S]*?"root",\s*"openmaus-runtime",\s*0o730/);
    expect(leaf).toMatch(/"\/var\/lib\/openmausbot-vm-homes"[\s\S]*?"root",\s*"openmaus-runtime",\s*0o730/);
    expect(service).toContain('Environment="OMB_LOCAL_VM_HOME_DIR=/var/lib/openmausbot-vm-homes"');
    expect(service).toContain('Environment="OMB_REQUIRE_STORAGE_ISOLATION=1"');
    expect(leaf).toContain("os.O_CREAT | os.O_EXCL");
    expect(leaf).toContain("storage root lock is unsafe");
    expect(leaf).toContain("empty_tree_fd(fd, device, [100_000])");
    expect(leaf).toContain("storage leaf retirement is incomplete");
    expect(leaf).toContain('f".retired-{key}-{uuid.uuid4().hex}"');
    expect(setup).toContain('if sys.argv[1] == "--check-mounted"');
    expect(setup).toContain("storage mount ownership or mode drifted");
  });

  it("installs and requires the exact firewall, private-net, and aggregate-slice checks", () => {
    const readme = asset("README.md");
    const service = asset("openmausbot.service");
    const companionService = asset("openmausbot-companion.service");
    const supervisor = asset("openmaus-provider-supervisor");
    expect(readme).toContain("/usr/local/libexec/openmaus-provider-network");
    expect(readme).toContain("/usr/local/libexec/openmaus-provider-slice-check");
    expect(service).toContain("Requires=openmaus-provider-network.service");
    expect(service).toContain("Requires=openmaus-provider.slice");
    expect(service).toContain("ExecStartPre=+/usr/local/libexec/openmaus-provider-network --check");
    expect(service).toContain("ExecStartPre=+/usr/local/libexec/openmaus-provider-slice-check --check");
    expect(service.match(/^ExecStartPre=\+\/usr\/bin\/btrfs qgroup show --raw /gm)).toHaveLength(3);
    expect(companionService).toContain("RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK");
    expect(service).toContain("/usr/bin/slirp4netns");
    expect(service).toContain('Environment="OMB_PROVIDER_HARNESS_HOST=10.0.2.2"');
    expect(service).toContain('Environment="OMB_REQUIRE_LOCAL_VM_NETWORK_ISOLATION=1"');
    expect(supervisor).toContain('"--unshare-net",');
    expect(supervisor).toContain('"--block-fd", str(block_read)');
    expect(supervisor).toContain('"--info-fd", str(info_write)');
    expect(supervisor).toContain("metadata_deadline = time.monotonic() + 5.0");
    expect(supervisor).toContain('"--property=RestrictNamespaces=~cgroup"');
    expect(supervisor).toContain('"--property=LimitCORE=0"');
    expect(supervisor).not.toContain('"--property=RestrictNamespaces=~cgroup net"');
    const preflight = asset("openmaus-noncutover-preflight");
    expect(preflight).toContain('"productionUnitsStarted": False');
    expect(preflight).toContain('"/usr/local/libexec/openmaus-provider-network", "--check"');
    expect(preflight).toContain('"/usr/local/libexec/openmaus-storage-setup", "--check-mounted"');
    expect(preflight).toContain('"/usr/bin/node", "/usr/local/libexec/openmaus-provider-integration"');
    expect(preflight).toContain("require_noncutover_state()\n");
  });

  it("attests every provider and Local VM network rule instead of marker-only checks", () => {
    const network = asset("openmaus-provider-network");
    for (const marker of [
      "provider-bandwidth-v1",
      "provider-harness-v4-v1",
      "provider-private-v4-v1",
      "provider-private-v6-v1",
      "vm-host-viewer-output-v1",
      "vm-host-output-deny-v1",
      "vm-host-deny-v1",
      "vm-bandwidth-v1",
      "vm-cross-deny-v1",
      "vm-private-v4-v1",
      "vm-private-v6-v1",
      "vm-public-egress-v1",
      "vm-loopback-viewer-v1",
      "vm-return-v1",
      "vm-unsolicited-inbound-deny-v1",
    ]) expect(network).toContain(marker);
    expect(network).toContain('semantic_objects(expected, table_alias=(probe_table, "openmaus_provider")) != semantic_objects(loaded)');
    expect(network).toContain("Preserve every other present field");
    expect(network).toContain('kind not in ("table", "chain", "rule")');
    expect(network).toContain("nft semantic normalizer accepted policy drift");
    expect(network).toContain("::ffff:0:0/96");
    execFileSync("python3", [
      new URL("../deploy/razer-remote/openmaus-provider-network", import.meta.url).pathname,
      "--normalizer-self-test",
    ]);
  });

  it("documents only the reserved Local VM guest and current Ian Brain allow-list", () => {
    const remote = asset("README.md");
    const ian = readFileSync(new URL("../deploy/razer-ian-brain/README.md", import.meta.url), "utf8");
    expect(remote).toContain("locked Cua UID `61000`");
    expect(remote).not.toContain("container as Cua UID `1000`");
    expect(remote).toContain("exact 27-name broker allow-list");
    expect(ian).toContain("currently 27");
    expect(ian).not.toContain("currently 30");
  });
});

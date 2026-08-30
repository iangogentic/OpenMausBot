/** The Razer remote shell is a distinct product without its own signed update
 * feed. It must never consume the normal OpenMausBot GitHub release stream.
 * Windows builds are currently unsigned, so accepting mutable release-feed
 * installers there would provide no publisher identity to verify. */
export function shouldStartUpdater({ packaged, remotePackage, platform = process.platform }) {
  return packaged === true && remotePackage !== true && platform !== "win32";
}

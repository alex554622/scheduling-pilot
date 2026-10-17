import { isNativeApp } from "./platform";

/**
 * Hand a file the app made (CSV export, PDF) to the person.
 *
 * A browser saves it to Downloads through an `<a download>` click. The app's
 * web view has no Downloads and silently drops that click, so on a phone the
 * file is written to the app's cache and offered through the system share
 * sheet instead — from there it can go to Files, Drive, email or a printer.
 */
export async function saveFile(blob: Blob, filename: string): Promise<void> {
  if (!isNativeApp()) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked on the next tick: some browsers start the download after the
    // click handler returns, and a URL revoked before then downloads nothing.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return;
  }

  const [{ Filesystem, Directory }, { Share }] = await Promise.all([
    import("@capacitor/filesystem"),
    import("@capacitor/share"),
  ]);
  const { uri } = await Filesystem.writeFile({
    path: safeName(filename),
    data: await toBase64(blob),
    directory: Directory.Cache,
  });
  try {
    await Share.share({ title: filename, files: [uri] });
  } catch (error) {
    // Closing the share sheet without picking anything is not a failure.
    if (!/cancel/i.test(String((error as { message?: string })?.message ?? error))) throw error;
  }
}

function safeName(filename: string): string {
  return filename.replace(/[\\/:*?"<>|]+/g, "-");
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file"));
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

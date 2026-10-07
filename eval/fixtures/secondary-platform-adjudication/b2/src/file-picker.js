export async function chooseDocument(view) {
  view.setStatus('choosing');
  const [handle] = await window.showOpenFilePicker();
  const file = await handle.getFile();
  view.addFilename(file.name);
  view.setStatus('ready');
}

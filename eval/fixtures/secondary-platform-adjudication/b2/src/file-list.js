export function showFileNames(files, view) {
  for (const file of files) view.addFilename(file.name);
}

import { registerLspFindReferencesDock } from "./lib/lsp_find_references_dock.ts";
import { handleBufferSearchTextInput } from "./lib/buffer_search_bar.ts";
import { handleFindFilesTextInput } from "./lib/find_in_files.ts";

registerLspFindReferencesDock();

function freshoneModeTextInput(data: { text: string }): void {
  if (handleBufferSearchTextInput(data)) return;
  handleFindFilesTextInput(data);
}
registerHandler("mode_text_input", freshoneModeTextInput);

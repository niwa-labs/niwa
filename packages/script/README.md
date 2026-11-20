# @niwa-labs/script

The types of the workflow script language: step signatures, the `ScriptApi` interface and the declarations a script makes, in a file that imports nothing. It also holds the reader of a script's header (`scriptOn` and the helpers under it), which reads the declaration from the text without running the script. It needs no host and depends on its schema library and on `typescript`, which is loaded only when a script is read.

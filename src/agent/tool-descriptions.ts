export const BASH_DESCRIPTION =
	"run a bash command. defaults to the workspace; absolute paths and `~/...` reach anywhere else. returns stdout and stderr. output truncates to the last 2000 lines or 50KB, whichever hits first; full output lands in a temp file if cut. timeout in seconds optional.";

export const READ_DESCRIPTION =
	"read a file. paths resolve from the workspace, but absolute paths and `~/...` work too. text and images (jpg, png, gif, webp); images come back as attachments. text output truncates to 2000 lines or 50KB, whichever hits first — use offset and limit for long files, and keep paging until you have what you need.";

export const WRITE_DESCRIPTION =
	"write a file from scratch or replace it wholesale. creates the file if missing, overwrites if not, and makes parent directories as needed. paths resolve from the workspace; absolute and `~/...` also accepted.";

export const EDIT_DESCRIPTION =
	"edit a file with exact text replacement. each edits[].oldText must match a unique, non-overlapping slice of the original — overlapping or nested edits are rejected, so merge nearby changes into one entry rather than chaining them. don't pad oldText with large unchanged regions just to connect distant changes. paths resolve from the workspace; absolute and `~/...` also work.";

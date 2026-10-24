// IPC channel names shared by the main process and the preload script.
// The sandboxed preload cannot require local files, so preload.cjs keeps a copy:
// change both together.
module.exports = {
  GET_APP_INFO: "desktop:get-app-info",
  GET_BACKEND_TOKEN: "desktop:get-backend-token",
  PICK_FOLDER: "desktop:pick-folder",
  MENU_ACTION: "desktop:menu-action",
};

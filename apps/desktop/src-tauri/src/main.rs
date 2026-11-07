// Keeps a release build from opening a terminal window on Windows; harmless on macOS.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    sikrets_desktop_lib::run()
}

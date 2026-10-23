# Get the current date.
string(TIMESTAMP CURRENT_DATE "%Y-%m-%d")

option(UPGRADE_DEBUG "" OFF)

# Where Arc's in-app updater looks for new versions: the arc-update.json written by
# dev/windows/publish-update.ps1. Empty disables update checks unless the hidden
# main.updateFeedUrl setting provides one.
set(ARC_UPDATE_FEED_URL "" CACHE STRING "URL of the arc-update.json update feed")

# Read version from VERSION file
file(READ "${CMAKE_SOURCE_DIR}/VERSION" VERSION_STRING)
string(STRIP "${VERSION_STRING}" VERSION_STRING)

# Extract major.minor.patch for places that need it
string(REGEX MATCH "^[0-9]+\\.[0-9]+\\.[0-9]+" VERSION_BASE "${VERSION_STRING}")
if(NOT VERSION_BASE)
  set(VERSION_BASE "0.0.0")
endif()

set(VERSION_STRING_SHORT "${VERSION_BASE}")
set(CANONICAL_VERSION_STRING "${VERSION_BASE}")

configure_file(src/core/Version.cpp.in src/core/Version.cpp)

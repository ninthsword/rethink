This is a simple program that imitates some basic UART responses of my AC unit. This is enough to activate the LCW-007 module, which otherwise refuses to activate Wi-Fi when operated without the appliance.

For a compile-only development check, run from the repository root:

```sh
"${CXX:-g++}" --version
npm run typecheck:cpp
```

This requires a C++17 compiler and uses `-Wall -Wextra -fsyntax-only`. Set `CXX` to a
compiler executable to override `g++`. The check does not link or run the simulator and
does not open a serial device.

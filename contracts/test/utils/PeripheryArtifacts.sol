// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Compiles Uniswap v4-periphery's router and quoter (at the commit Elysium's
// deployed quoter was built from) so tests can deploy them by artifact name.
// They build against periphery's own bundled v4-core; tests talk to them only
// through ABI-compatible local interfaces, as a frontend would.
import {MockV4Router} from "../../lib/v4-periphery/test/mocks/MockV4Router.sol";
import {V4Quoter} from "../../lib/v4-periphery/src/lens/V4Quoter.sol";

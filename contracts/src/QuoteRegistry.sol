// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";

import {LaunchMath} from "./LaunchMath.sol";

/// @title QuoteRegistry
/// @notice Which ERC-20 quote assets new Mesa launches may pair against, at
/// what starting price, and through which pool the protocol's fees in that
/// asset are converted to HYPE. Native HYPE is always allowed and is not
/// listed here.
///
/// Deployed by MesaHook's constructor. Its admin is the only privileged role
/// in Mesa, and its reach ends here:
///  - Adding a quote, or changing an enabled one, takes `DELAY` after a public
///    proposal, and must then be activated (by anyone).
///  - Disabling a quote is immediate, and only stops new launches.
///  - Nothing here can touch an existing pool, its fees, claims or tokens.
///  - The admin can hand over in two steps, or renounce for good.
///
/// A quote must be a plain ERC-20: no transfer fee, no rebasing, no blocklist
/// that could freeze the PoolManager. That is checked by people during the
/// delay, not by code.
contract QuoteRegistry {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;

    uint32 public constant DELAY = 3 days;

    struct Quote {
        bool enabled;
        /// Starting tick of new pools, as the price in tokens per quote.
        int24 startTick;
        /// Pending proposal, usable from `pendingAt` (0 = none).
        uint64 pendingAt;
        int24 pendingTick;
    }

    address public admin;
    address public pendingAdmin;
    mapping(address quote => Quote) public quotes;
    mapping(address quote => PoolKey) internal routes;
    mapping(address quote => PoolKey) internal pendingRoutes;

    event QuoteProposed(address indexed quote, int24 startTick, PoolId route, uint64 usableAt);
    event QuoteCancelled(address indexed quote);
    event QuoteEnabled(address indexed quote, int24 startTick, PoolId route);
    event QuoteDisabled(address indexed quote);
    event AdminProposed(address next);
    event AdminChanged(address previous, address next);

    error NotAdmin();
    error BadQuote();
    error BadRoute();
    error NotReady();
    error NotAllowed();
    error NoRoute();

    constructor(address admin_) {
        admin = admin_;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    /// @notice Propose `quote`, its starting tick (tokens per quote) and the
    /// HYPE/quote pool its protocol fees are converted through. Replaces a
    /// pending proposal; an enabled quote keeps its current settings until the
    /// new proposal is activated.
    function propose(address quote, int24 startTick, PoolKey calldata route) external onlyAdmin {
        if (quote == address(0) || quote.code.length == 0) revert BadQuote();
        // A launched token can land on either side of the quote.
        LaunchMath.checkStartTick(startTick, true);
        LaunchMath.checkStartTick(startTick, false);
        if (!route.currency0.isAddressZero() || Currency.unwrap(route.currency1) != quote) revert BadRoute();
        Quote storage q = quotes[quote];
        uint64 usableAt = uint64(block.timestamp) + DELAY;
        q.pendingAt = usableAt;
        q.pendingTick = startTick;
        pendingRoutes[quote] = route;
        emit QuoteProposed(quote, startTick, route.toId(), usableAt);
    }

    /// @notice Withdraw a pending proposal.
    function cancel(address quote) external onlyAdmin {
        if (quotes[quote].pendingAt == 0) revert NotReady();
        quotes[quote].pendingAt = 0;
        delete pendingRoutes[quote];
        emit QuoteCancelled(quote);
    }

    /// @notice Enable a proposed quote once its delay has passed. Anyone may call.
    function activate(address quote) external {
        Quote storage q = quotes[quote];
        if (q.pendingAt == 0 || block.timestamp < q.pendingAt) revert NotReady();
        q.enabled = true;
        q.startTick = q.pendingTick;
        q.pendingAt = 0;
        routes[quote] = pendingRoutes[quote];
        delete pendingRoutes[quote];
        emit QuoteEnabled(quote, q.startTick, routes[quote].toId());
    }

    /// @notice Stop new launches against `quote`. Existing pools keep trading,
    /// and their fees stay claimable and convertible.
    function disable(address quote) external onlyAdmin {
        quotes[quote].enabled = false;
        emit QuoteDisabled(quote);
    }

    function transferAdmin(address next) external onlyAdmin {
        pendingAdmin = next;
        emit AdminProposed(next);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin || msg.sender == address(0)) revert NotAdmin();
        emit AdminChanged(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
    }

    /// @notice Give up the registry for good: no quote can be added again.
    function renounceAdmin() external onlyAdmin {
        emit AdminChanged(admin, address(0));
        admin = address(0);
        pendingAdmin = address(0);
    }

    /// @notice The starting tick of a new launch against `quote`. Reverts
    /// unless the quote is enabled.
    function startTickOf(address quote) external view returns (int24) {
        Quote storage q = quotes[quote];
        if (!q.enabled) revert NotAllowed();
        return q.startTick;
    }

    /// @notice The HYPE/quote pool that protocol fees in `quote` are sold through.
    function routeOf(address quote) external view returns (PoolKey memory route) {
        route = routes[quote];
        if (quote == address(0) || Currency.unwrap(route.currency1) != quote) revert NoRoute();
    }

    function pendingRouteOf(address quote) external view returns (PoolKey memory) {
        return pendingRoutes[quote];
    }
}

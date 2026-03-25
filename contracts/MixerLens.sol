// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./Mixer.sol";

/// @title MixerLens — read-only aggregator for Mixer dashboard data
/// @notice Batches multiple Mixer view calls into a single RPC round-trip.
///         Deploy independently; does not need to be set in Mixer.
contract MixerLens {
    struct MixerSnapshot {
        uint256 totalDeposited;
        uint256 totalWithdrawn;
        uint256 depositCount;
        uint256 withdrawalCount;
        uint256 poolBalance;
        uint256 anonymitySetSize;
        uint256 treeCapacity;
        uint256 treeUtilization;
        uint256 lastRoot;
        uint256 denomination;
        bool isPaused;
        uint256 maxDepositsPerAddress;
        address owner;
    }

    /// @notice Return a full snapshot of the given Mixer's current state.
    /// @param _mixer Address of a deployed Mixer contract.
    /// @return snapshot All dashboard-relevant fields aggregated in one call.
    function getSnapshot(address _mixer) external view returns (MixerSnapshot memory snapshot) {
        Mixer mixer = Mixer(payable(_mixer));
        (
            uint256 td,
            uint256 tw,
            uint256 dc,
            uint256 wc,
            uint256 pb
        ) = mixer.getStats();

        snapshot = MixerSnapshot({
            totalDeposited: td,
            totalWithdrawn: tw,
            depositCount: dc,
            withdrawalCount: wc,
            poolBalance: pb,
            anonymitySetSize: mixer.getAnonymitySetSize(),
            treeCapacity: mixer.getTreeCapacity(),
            treeUtilization: mixer.getTreeUtilization(),
            lastRoot: mixer.getLastRoot(),
            denomination: mixer.denomination(),
            isPaused: mixer.paused(),
            maxDepositsPerAddress: mixer.maxDepositsPerAddress(),
            owner: mixer.owner()
        });
    }
}

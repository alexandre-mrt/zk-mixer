// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IMixer {
    function withdraw(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256 _root,
        uint256 _nullifierHash,
        address payable _recipient,
        address payable _relayer,
        uint256 _fee
    ) external;
}

/// @notice Malicious contract that attempts to reenter Mixer.withdraw inside receive().
/// Used only in tests to verify the ReentrancyGuard blocks reentrant calls.
contract ReentrancyAttacker {
    IMixer public mixer;
    uint256 public attackCount;

    uint256 public savedRoot;
    uint256 public savedNullifier;

    constructor(address _mixer) {
        mixer = IMixer(_mixer);
    }

    function attack(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256 _root,
        uint256 _nullifierHash
    ) external {
        savedRoot = _root;
        savedNullifier = _nullifierHash;
        mixer.withdraw(
            _pA,
            _pB,
            _pC,
            _root,
            _nullifierHash,
            payable(address(this)),
            payable(address(0)),
            0
        );
    }

    receive() external payable {
        attackCount++;
        if (attackCount < 3) {
            uint256 newNullifier = savedNullifier + attackCount;
            uint256[2] memory zero2 = [uint256(0), 0];
            uint256[2][2] memory zero22 = [[uint256(0), 0], [uint256(0), 0]];
            try mixer.withdraw(
                zero2,
                zero22,
                zero2,
                savedRoot,
                newNullifier,
                payable(address(this)),
                payable(address(0)),
                0
            ) {
                // Should never reach here — ReentrancyGuard must block this
            } catch {
                // Expected: reentrant call is rejected
            }
        }
    }
}

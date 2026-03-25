// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title DepositReceipt — ERC721 receipt for mixer deposits
/// @notice Minted on each deposit as a non-transferable receipt (soulbound).
/// Does NOT grant withdrawal rights — the ZK proof is what proves ownership.
contract DepositReceipt is ERC721 {
    address public immutable mixer;
    uint256 private _nextTokenId;

    mapping(uint256 => uint256) public tokenCommitment; // tokenId => commitment
    mapping(uint256 => uint256) public tokenTimestamp;  // tokenId => deposit timestamp

    modifier onlyMixer() {
        require(msg.sender == mixer, "DepositReceipt: only mixer");
        _;
    }

    constructor(address _mixer) ERC721("ZK Mixer Deposit Receipt", "ZKDR") {
        require(_mixer != address(0), "DepositReceipt: zero mixer");
        mixer = _mixer;
    }

    /// @notice Mint a receipt NFT to `_to` for the given `_commitment`.
    /// @dev Only callable by the mixer contract.
    /// @param _to         Address of the depositor.
    /// @param _commitment Poseidon(secret, nullifier) recorded on the token.
    /// @return tokenId    The minted token ID.
    function mint(address _to, uint256 _commitment) external onlyMixer returns (uint256) {
        uint256 tokenId = _nextTokenId++;
        _safeMint(_to, tokenId);
        tokenCommitment[tokenId] = _commitment;
        tokenTimestamp[tokenId] = block.timestamp;
        return tokenId;
    }

    /// @notice Soulbound — disable all transfers.
    /// @dev Overrides ERC721._update to allow only mint (from == 0) and burn (to == 0).
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        // Allow minting (from == address(0)) and burning (to == address(0))
        require(
            from == address(0) || to == address(0),
            "DepositReceipt: soulbound, non-transferable"
        );
        return super._update(to, tokenId, auth);
    }
}

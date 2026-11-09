// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @title EuthynaExecutor
/// @notice The code a company wallet delegates to with EIP-7702, so that anyone (Euthyna's relayer)
/// can submit the wallet's calls and pay their gas. The wallet has no private key: its key is held
/// by NEAR MPC and signs only what the company's vault decided. This contract runs a call only when
/// that same key signed it, as EIP-712 `Execute`, once per operation id and before a deadline.
///
/// It holds no admin, no owner, no upgrade path and no state but the used operation ids, kept in an
/// ERC-7201 namespaced slot so that it cannot collide with any other code the wallet may delegate to.
/// After a successful call it emits `Executed(opId)`, which the vault settles on, as attested by
/// NEAR MPC. A failed call reverts the whole transaction: no event, the vault does not settle, and
/// the operation can still be released after its deadline.
///
/// `executeBatch` runs several calls under one signature, all or nothing: the vault uses it for
/// approve + call + revoke, so a router gets exactly the tokens of one swap and no approval is
/// left behind.
contract EuthynaExecutor {
    /// keccak256("Execute(address to,uint256 value,bytes data,bytes32 opId,uint256 deadline)")
    bytes32 public constant EXECUTE_TYPEHASH = keccak256("Execute(address to,uint256 value,bytes data,bytes32 opId,uint256 deadline)");
    bytes32 public constant CALL_TYPEHASH = keccak256("Call(address to,uint256 value,bytes data)");
    bytes32 public constant BATCH_TYPEHASH =
        keccak256("Batch(Call[] calls,bytes32 opId,uint256 deadline)Call(address to,uint256 value,bytes data)");
    /// keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("EuthynaExecutor");
    bytes32 private constant VERSION_HASH = keccak256("1");
    /// secp256k1n / 2: signatures with a higher s are malleable copies and are refused.
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    /// keccak256(abi.encode(uint256(keccak256("euthyna.executor.used")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant USED_SLOT = 0xb14470db056c8f89d4f00de1ce87371b0f49c0ca2c80989a577b5d6d0db5b100;

    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    event Executed(bytes32 indexed opId);

    error Expired();
    error AlreadyExecuted();
    error BadSignature();
    error CallFailed(bytes reason);
    error BatchCallFailed(uint256 index, bytes reason);
    error EmptyBatch();

    /// The EIP-712 domain of this wallet: its own address, on this chain.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    /// The digest the vault asks NEAR MPC to sign for one call.
    function digest(address to, uint256 value, bytes calldata data, bytes32 opId, uint256 deadline) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(EXECUTE_TYPEHASH, to, value, keccak256(data), opId, deadline));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function executed(bytes32 opId) public view returns (bool) {
        return _used()[opId];
    }

    /// Runs one call the wallet's key signed. Callable by anyone: the caller only pays the gas.
    function execute(
        address to,
        uint256 value,
        bytes calldata data,
        bytes32 opId,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _authorize(digest(to, value, data, opId, deadline), opId, deadline, v, r, s);
        (bool ok, bytes memory reason) = to.call{value: value}(data);
        if (!ok) revert CallFailed(reason);
        emit Executed(opId);
    }

    /// The digest the vault asks NEAR MPC to sign for a batch.
    function batchDigest(Call[] calldata calls, bytes32 opId, uint256 deadline) public view returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            hashes[i] = keccak256(abi.encode(CALL_TYPEHASH, calls[i].to, calls[i].value, keccak256(calls[i].data)));
        }
        bytes32 structHash = keccak256(abi.encode(BATCH_TYPEHASH, keccak256(abi.encodePacked(hashes)), opId, deadline));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// Runs the calls the wallet's key signed together, in order, all or nothing.
    function executeBatch(Call[] calldata calls, bytes32 opId, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        if (calls.length == 0) revert EmptyBatch();
        _authorize(batchDigest(calls, opId, deadline), opId, deadline, v, r, s);
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory reason) = calls[i].to.call{value: calls[i].value}(calls[i].data);
            if (!ok) revert BatchCallFailed(i, reason);
        }
        emit Executed(opId);
    }

    /// Deadline, one run per id, low-s, and the signer is the wallet itself.
    function _authorize(bytes32 hash, bytes32 opId, uint256 deadline, uint8 v, bytes32 r, bytes32 s) private {
        if (block.timestamp > deadline) revert Expired();
        mapping(bytes32 => bool) storage used = _used();
        if (used[opId]) revert AlreadyExecuted();
        if (uint256(s) > HALF_N) revert BadSignature();
        address signer = ecrecover(hash, v, r, s);
        // Without delegation, address(this) is this contract, which has no key: nothing verifies.
        if (signer == address(0) || signer != address(this)) revert BadSignature();
        used[opId] = true;
    }

    /// A delegated wallet keeps receiving ETH like the plain address it was.
    receive() external payable {}

    /// ...and NFTs: with code at its address, the wallet is asked to accept safe transfers and safe
    /// mints (ERC-721, ERC-1155). A plain address never was, so these accept everything, as before.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155BatchReceived.selector;
    }

    /// ERC-165: ERC-165 itself and ERC1155TokenReceiver (which ERC-1155 requires receivers to declare).
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x4e2312e0;
    }

    function _used() private pure returns (mapping(bytes32 => bool) storage used) {
        bytes32 slot = USED_SLOT;
        assembly {
            used.slot := slot
        }
    }
}

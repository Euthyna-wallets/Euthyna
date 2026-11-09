// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {EuthynaExecutor} from "../src/EuthynaExecutor.sol";

interface Vm {
    function addr(uint256 privateKey) external pure returns (address);
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function signAndAttachDelegation(address implementation, uint256 privateKey) external returns (SignedDelegation memory);
    function expectRevert(bytes4 selector) external;
    function expectRevert() external;
    function expectEmit(bool, bool, bool, bool, address) external;
    function warp(uint256) external;
    function deal(address, uint256) external;
    function prank(address) external;
    function load(address, bytes32) external view returns (bytes32);
    struct SignedDelegation { uint8 v; bytes32 r; bytes32 s; uint64 nonce; address implementation; }
}

contract Token {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// The receiver checks of OpenZeppelin's ERC-721 `_safeMint`/`safeTransferFrom` and of ERC-1155.
contract Nft {
    mapping(uint256 => address) public ownerOf;
    function safeMint(address to, uint256 id) external {
        ownerOf[id] = to;
        if (to.code.length > 0) {
            bytes4 ok = IERC721Receiver(to).onERC721Received(msg.sender, address(0), id, "");
            require(ok == IERC721Receiver.onERC721Received.selector, "ERC721: refused");
        }
    }
    function safeMint1155(address to, uint256 id) external {
        bytes4 ok = IERC1155Receiver(to).onERC1155Received(msg.sender, address(0), id, 1, "");
        require(ok == IERC1155Receiver.onERC1155Received.selector, "ERC1155: refused");
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        bytes4 batch = IERC1155Receiver(to).onERC1155BatchReceived(msg.sender, address(0), ids, ids, "");
        require(batch == IERC1155Receiver.onERC1155BatchReceived.selector, "ERC1155: batch refused");
    }
}
interface IERC721Receiver { function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4); }
interface IERC1155Receiver {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4);
    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata) external returns (bytes4);
}

contract EuthynaExecutorTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    event Executed(bytes32 indexed opId);

    uint256 constant WALLET_KEY = 0xA11CE; // stands for the company wallet's NEAR MPC key
    uint256 constant OTHER_KEY = 0xB0B;
    EuthynaExecutor implementation;
    Token token;
    address wallet;
    address constant SUPPLIER = address(0x5EEF);
    address constant RELAYER = address(0xFEE);

    function setUp() public {
        implementation = new EuthynaExecutor();
        token = new Token();
        wallet = vm.addr(WALLET_KEY);
        vm.signAndAttachDelegation(address(implementation), WALLET_KEY);
        token.mint(wallet, 100e6);
    }

    function _signed(uint256 key, address to, uint256 value, bytes memory data, bytes32 opId, uint256 deadline)
        internal view returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 d = EuthynaExecutor(payable(wallet)).digest(to, value, data, opId, deadline);
        (v, r, s) = vm.sign(key, d);
    }

    function _pay(uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeCall(Token.transfer, (SUPPLIER, amount));
    }

    function test_relayer_runs_a_call_the_wallet_key_signed_and_pays_nothing_from_the_wallet() public {
        bytes memory data = _pay(5e6);
        bytes32 opId = keccak256("op-1");
        (uint8 v, bytes32 r, bytes32 s) = _signed(WALLET_KEY, address(token), 0, data, opId, block.timestamp + 1 hours);
        vm.expectEmit(true, false, false, false, wallet);
        emit Executed(opId);
        vm.prank(RELAYER);
        EuthynaExecutor(payable(wallet)).execute(address(token), 0, data, opId, block.timestamp + 1 hours, v, r, s);
        require(token.balanceOf(SUPPLIER) == 5e6, "supplier not paid");
        require(token.balanceOf(wallet) == 95e6, "wallet not debited");
        require(wallet.balance == 0, "wallet paid gas");
        require(EuthynaExecutor(payable(wallet)).executed(opId), "not marked");
    }

    function test_a_signature_runs_once() public {
        bytes memory data = _pay(1e6);
        bytes32 opId = keccak256("op-2");
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signed(WALLET_KEY, address(token), 0, data, opId, deadline);
        EuthynaExecutor(payable(wallet)).execute(address(token), 0, data, opId, deadline, v, r, s);
        vm.expectRevert(EuthynaExecutor.AlreadyExecuted.selector);
        EuthynaExecutor(payable(wallet)).execute(address(token), 0, data, opId, deadline, v, r, s);
    }

    function test_another_key_cannot_make_the_wallet_pay() public {
        bytes memory data = _pay(100e6);
        bytes32 opId = keccak256("op-3");
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signed(OTHER_KEY, address(token), 0, data, opId, deadline);
        vm.expectRevert(EuthynaExecutor.BadSignature.selector);
        EuthynaExecutor(payable(wallet)).execute(address(token), 0, data, opId, deadline, v, r, s);
    }

    function test_the_relayer_cannot_change_recipient_amount_or_deadline() public {
        bytes memory data = _pay(1e6);
        bytes32 opId = keccak256("op-4");
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signed(WALLET_KEY, address(token), 0, data, opId, deadline);
        bytes memory other = abi.encodeCall(Token.transfer, (RELAYER, 1e6));
        vm.expectRevert(EuthynaExecutor.BadSignature.selector);
        EuthynaExecutor(payable(wallet)).execute(address(token), 0, other, opId, deadline, v, r, s);
        vm.expectRevert(EuthynaExecutor.BadSignature.selector);
        EuthynaExecutor(payable(wallet)).execute(address(token), 0, _pay(2e6), opId, deadline, v, r, s);
        vm.expectRevert(EuthynaExecutor.BadSignature.selector);
        EuthynaExecutor(payable(wallet)).execute(address(token), 0, data, opId, deadline + 1, v, r, s);
        vm.expectRevert(EuthynaExecutor.BadSignature.selector);
        EuthynaExecutor(payable(wallet)).execute(address(token), 0, data, keccak256("op-5"), deadline, v, r, s);
    }

    function test_expired_signature_does_nothing() public {
        bytes memory data = _pay(1e6);
        bytes32 opId = keccak256("op-6");
        uint256 deadline = block.timestamp + 10;
        (uint8 v, bytes32 r, bytes32 s) = _signed(WALLET_KEY, address(token), 0, data, opId, deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(EuthynaExecutor.Expired.selector);
        EuthynaExecutor(payable(wallet)).execute(address(token), 0, data, opId, deadline, v, r, s);
    }

    function test_a_failed_call_reverts_and_leaves_the_id_unused() public {
        bytes memory data = _pay(1_000e6); // more than the wallet holds
        bytes32 opId = keccak256("op-7");
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signed(WALLET_KEY, address(token), 0, data, opId, deadline);
        vm.expectRevert();
        EuthynaExecutor(payable(wallet)).execute(address(token), 0, data, opId, deadline, v, r, s);
        require(!EuthynaExecutor(payable(wallet)).executed(opId), "id burnt by a failure");
    }

    function test_high_s_copy_of_a_signature_is_refused() public {
        bytes memory data = _pay(1e6);
        bytes32 opId = keccak256("op-8");
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signed(WALLET_KEY, address(token), 0, data, opId, deadline);
        bytes32 highS = bytes32(0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141 - uint256(s));
        vm.expectRevert(EuthynaExecutor.BadSignature.selector);
        EuthynaExecutor(payable(wallet)).execute(address(token), 0, data, opId, deadline, v == 27 ? 28 : 27, r, highS);
    }

    function test_the_contract_itself_runs_nothing() public {
        bytes memory data = _pay(1e6);
        bytes32 opId = keccak256("op-9");
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 d = implementation.digest(address(token), 0, data, opId, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(WALLET_KEY, d);
        vm.expectRevert(EuthynaExecutor.BadSignature.selector);
        implementation.execute(address(token), 0, data, opId, deadline, v, r, s);
    }

    function test_used_ids_live_in_the_namespaced_slot() public {
        bytes memory data = _pay(1e6);
        bytes32 opId = keccak256("op-10");
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signed(WALLET_KEY, address(token), 0, data, opId, deadline);
        EuthynaExecutor(payable(wallet)).execute(address(token), 0, data, opId, deadline, v, r, s);
        bytes32 root = bytes32(uint256(keccak256(abi.encode(uint256(keccak256("euthyna.executor.used")) - 1))) & ~uint256(0xff));
        require(vm.load(wallet, keccak256(abi.encode(opId, root))) == bytes32(uint256(1)), "slot");
        require(vm.load(wallet, bytes32(0)) == bytes32(0), "slot 0 touched");
    }

    function test_the_wallet_still_sends_eth_through_a_signed_call() public {
        vm.deal(wallet, 1 ether);
        bytes32 opId = keccak256("op-11");
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signed(WALLET_KEY, SUPPLIER, 0.25 ether, "", opId, deadline);
        EuthynaExecutor(payable(wallet)).execute(SUPPLIER, 0.25 ether, "", opId, deadline, v, r, s);
        require(SUPPLIER.balance == 0.25 ether && wallet.balance == 0.75 ether, "eth");
    }

    function test_the_delegated_wallet_still_receives_nfts() public {
        assert(wallet.code.length > 0);
        Nft nft = new Nft();
        nft.safeMint(wallet, 1);
        assert(nft.ownerOf(1) == wallet);
        nft.safeMint1155(wallet, 2);
        assert(EuthynaExecutor(payable(wallet)).supportsInterface(0x4e2312e0));
        assert(EuthynaExecutor(payable(wallet)).supportsInterface(0x01ffc9a7));
        assert(!EuthynaExecutor(payable(wallet)).supportsInterface(0xffffffff));
    }
}

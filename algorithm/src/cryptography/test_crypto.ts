import MockCrypto from "./mock_crypto.js";

// Just some testing. TODO: turn into unit tests

function test_mock_crypto() {
	const crypto = new MockCrypto(3, 5);
	const keys = crypto.keygen();
	console.log("Keys: ", keys);

	const msg = "Hello";
	const signatures = [];
	for (const key of keys[1]) {
		signatures.push(crypto.sign(msg, key));
	}

	console.log("Signatures: ", signatures);

	const full_sig1 = crypto.combine(msg, signatures);
	const full_sig2 = crypto.combine(msg, signatures.slice(0, 2));

	console.log("Full Signature Try 1 (should succeed): ", full_sig1);
	console.log("Full Signature Try 2 (should fail): ", full_sig2);

	const verify1 = crypto.verify(msg, full_sig1 ?? "", keys[0]);
	const verify2 = crypto.verify(msg, "Some invalid signature", keys[0]);

	console.log("Verify 1 (should be true): ", verify1);
	console.log("Verify 2 (should be false): ", verify2);
}

test_mock_crypto();

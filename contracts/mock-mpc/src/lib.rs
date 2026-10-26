use near_sdk::serde_json::Value;
use near_sdk::{
    AccountId, Gas, GasWeight, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue,
    YieldId, env, near, require,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, PartialEq, Eq)]
#[near(serializers = [borsh, json])]
pub enum Mode {
    Success,
    Fail,
    Timeout,
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
#[serde(crate = "near_sdk::serde")]
#[serde(tag = "scheme")]
pub enum SignatureResponse {
    Secp256k1 {
        big_r: BigR,
        s: Scalar,
        recovery_id: u8,
    },
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct BigR {
    affine_point: String,
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct Scalar {
    scalar: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockMpc {
    foreign_request: Option<String>,
    foreign_response: Option<String>,
    pending_foreign: Option<YieldId>,
    public_key: String,
    mode: Mode,
    pending_sign: Option<YieldId>,
}

#[near]
impl MockMpc {
    #[init]
    pub fn new(public_key: String) -> Self {
        Self {
            foreign_request: None,
            foreign_response: None,
            pending_foreign: None,
            public_key,
            mode: Mode::Success,
            pending_sign: None,
        }
    }

    /// Test fixture: pin the complete expected request and independently supplied response.
    pub fn set_foreign_fixture(&mut self, request: Value, payload_hash: String) {
        self.foreign_request = Some(request.to_string());
        self.foreign_response = Some(
            near_sdk::serde_json::json!({"payload_hash":payload_hash,"signature":Self::signature()}).to_string(),
        );
    }
    #[payable]
    pub fn verify_foreign_transaction(&mut self, request: Value) -> PromiseOrValue<Value> {
        require!(env::attached_deposit().as_yoctonear() >= 1, "ERR_DEPOSIT");
        require!(request["payload_version"] == 1, "ERR_PAYLOAD_VERSION");
        let evm = request["request"].as_object().expect("ERR_CHAIN");
        require!(evm.len() == 1, "ERR_CHAIN");
        let body = evm.values().next().unwrap();
        require!(body["finality"] == "Finalized", "ERR_FINALITY");
        // A real mismatching proof may never be answered. Simulate an unresolved
        // verification without letting it prevent other requests from completing.
        if self.mode == Mode::Timeout {
            let (promise, id) =
                Promise::new_yield("on_foreign_yield", b"{}", Gas::from_tgas(5), GasWeight(1));
            self.pending_foreign = Some(id);
            return PromiseOrValue::Promise(promise);
        }
        require!(
            Some(&request.to_string()) == self.foreign_request.as_ref(),
            "ERR_REQUEST_BINDING"
        );
        match self.mode {
            Mode::Success => PromiseOrValue::Value(
                near_sdk::serde_json::from_str(
                    self.foreign_response.as_ref().expect("ERR_NO_FIXTURE"),
                )
                .expect("ERR_FIXTURE_JSON"),
            ),
            Mode::Fail => env::panic_str("ERR_MOCK_VERIFY"),
            Mode::Timeout => unreachable!(),
        }
    }
    pub fn has_pending_verification(&self) -> bool {
        self.pending_foreign.is_some()
    }
    pub fn respond_verify_foreign_tx(&mut self) {
        let id = self.pending_foreign.take().expect("ERR_NO_PENDING_VERIFY");
        id.resume(
            self.foreign_response
                .as_ref()
                .expect("ERR_NO_FIXTURE")
                .as_bytes(),
        )
        .expect("ERR_RESUME_VERIFY");
    }
    #[private]
    pub fn on_foreign_yield(
        &self,
        #[callback_result] result: Result<Value, PromiseError>,
    ) -> Value {
        result.expect("ERR_MOCK_TIMEOUT")
    }

    pub fn set_mode(&mut self, mode: Mode) {
        self.mode = mode;
    }
    pub fn derived_public_key(
        &self,
        path: String,
        predecessor: Option<AccountId>,
        domain_id: Option<u64>,
    ) -> String {
        let _ = (path, predecessor, domain_id);
        self.public_key.clone()
    }

    #[payable]
    pub fn sign(&mut self, request: Value) -> PromiseOrValue<SignatureResponse> {
        require!(
            env::attached_deposit() >= NearToken::from_yoctonear(1),
            "ERR_DEPOSIT"
        );
        let _ = request;
        match self.mode {
            Mode::Success => PromiseOrValue::Value(Self::signature()),
            Mode::Fail => env::panic_str("ERR_MOCK_SIGN"),
            Mode::Timeout => {
                let (promise, yield_id) =
                    Promise::new_yield("on_yield", b"{}", Gas::from_tgas(5), GasWeight(1));
                self.pending_sign = Some(yield_id);
                PromiseOrValue::Promise(promise)
            }
        }
    }

    pub fn resume_sign(&mut self) {
        let yield_id = self
            .pending_sign
            .take()
            .unwrap_or_else(|| env::panic_str("ERR_NO_PENDING_SIGN"));
        let payload = near_sdk::serde_json::to_vec(&Self::signature())
            .unwrap_or_else(|_| env::panic_str("ERR_SERIALIZE_SIGNATURE"));
        yield_id
            .resume(payload)
            .unwrap_or_else(|_| env::panic_str("ERR_RESUME_SIGN"));
    }

    #[private]
    pub fn on_yield(
        &self,
        #[callback_result] result: Result<SignatureResponse, PromiseError>,
    ) -> SignatureResponse {
        result.unwrap_or_else(|_| env::panic_str("ERR_MOCK_TIMEOUT"))
    }

    fn signature() -> SignatureResponse {
        SignatureResponse::Secp256k1 {
            big_r: BigR {
                affine_point: format!("02{}", "11".repeat(32)),
            },
            s: Scalar {
                scalar: "22".repeat(32),
            },
            recovery_id: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::{test_utils::VMContextBuilder, testing_env};
    fn fixture() -> (MockMpc, Value) {
        testing_env!(
            VMContextBuilder::new()
                .attached_deposit(NearToken::from_yoctonear(1))
                .prepaid_gas(Gas::from_tgas(300))
                .build()
        );
        let request = near_sdk::serde_json::json!({"request":{"Base":{"tx_id":"11".repeat(32),"extractors":["BlockHash"],"finality":"Finalized"}},"domain_id":3,"payload_version":1,"expected_payload_hash":"22".repeat(32)});
        let mut mpc = MockMpc::new("unused".into());
        mpc.set_foreign_fixture(request.clone(), "22".repeat(32));
        (mpc, request)
    }
    #[test]
    fn foreign_verification_respond_flow() {
        let (mut mpc, request) = fixture();
        mpc.set_mode(Mode::Timeout);
        let _ = mpc.verify_foreign_transaction(request);
        assert!(mpc.pending_foreign.is_some());
        mpc.respond_verify_foreign_tx();
        assert!(mpc.pending_foreign.is_none());
    }
    #[test]
    #[should_panic(expected = "ERR_FINALITY")]
    fn latest_is_not_provable() {
        let (mut mpc, mut request) = fixture();
        request["request"]["Base"]["finality"] = Value::String("Latest".into());
        let _ = mpc.verify_foreign_transaction(request);
    }
    #[test]
    #[should_panic(expected = "ERR_REQUEST_BINDING")]
    fn proof_for_another_transaction_fails() {
        let (mut mpc, mut request) = fixture();
        request["request"]["Base"]["tx_id"] = Value::String("99".repeat(32));
        let _ = mpc.verify_foreign_transaction(request);
    }
    #[test]
    #[should_panic(expected = "ERR_REQUEST_BINDING")]
    fn proof_for_another_chain_fails() {
        let (mut mpc, mut request) = fixture();
        let body = request["request"]["Base"].take();
        request["request"] = near_sdk::serde_json::json!({"Arbitrum":body});
        let _ = mpc.verify_foreign_transaction(request);
    }
}

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
    public_key: String,
    mode: Mode,
    pending_sign: Option<YieldId>,
}

#[near]
impl MockMpc {
    #[init]
    pub fn new(public_key: String) -> Self {
        Self {
            public_key,
            mode: Mode::Success,
            pending_sign: None,
        }
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

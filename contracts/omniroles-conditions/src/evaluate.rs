//! Evaluation of a condition tree against one call.

use std::collections::BTreeMap;

use sha3::{Digest, Keccak256};

use crate::abi::{self, Word};
use crate::tree::{Layout, Node, Tree};
use crate::types::{Allowance, ConditionFlat, Consumption, Encoding, Operator, Status};

/// Where allowance state is read from (vault storage, tests).
pub trait AllowanceSource {
    fn allowance(&self, key: &[u8; 32]) -> Option<Allowance>;
}

impl AllowanceSource for BTreeMap<[u8; 32], Allowance> {
    fn allowance(&self, key: &[u8; 32]) -> Option<Allowance> {
        self.get(key).cloned()
    }
}

/// The call being checked.
pub struct Context<'a> {
    /// Full calldata, selector included.
    pub calldata: &'a [u8],
    /// Native value sent with the call (wei).
    pub value: u128,
    /// The wallet the role acts for (`EqualToAvatar`).
    pub avatar: [u8; 20],
    /// Seconds since epoch, for allowance accrual.
    pub now: u64,
    pub allowances: &'a dyn AllowanceSource,
}

/// Validate `conditions`, then evaluate them. On success, returns the
/// allowance consumptions to persist once the call is executed.
pub fn evaluate(
    conditions: &[ConditionFlat],
    context: &Context,
) -> Result<Vec<Consumption>, Status> {
    let tree = Tree::build(conditions).map_err(|_| Status::ConditionsInvalid)?;
    evaluate_tree(&tree, context)
}

pub fn evaluate_tree(tree: &Tree, context: &Context) -> Result<Vec<Consumption>, Status> {
    let root = tree.root();
    let region = match &root.layout {
        Layout::AbiEncoded(_, leading) => Some(
            context
                .calldata
                .get(*leading..)
                .ok_or(Status::CalldataTooShort)?,
        ),
        _ => None,
    };
    let mut evaluator = Evaluator {
        tree,
        context,
        consumptions: Vec::new(),
    };
    evaluator.eval(root, region)?;
    Ok(evaluator.consumptions)
}

struct Evaluator<'t, 'c> {
    tree: &'t Tree,
    context: &'t Context<'c>,
    consumptions: Vec<Consumption>,
}

impl<'t, 'c> Evaluator<'t, 'c> {
    fn child(&self, index: usize) -> &'t Node {
        self.tree.node(index)
    }

    /// `region`: where the node's value starts (`None` for non-structural nodes).
    fn eval(&mut self, node: &Node, region: Option<&[u8]>) -> Result<(), Status> {
        let id = node.index;
        match node.operator {
            Operator::Pass => Ok(()),
            Operator::And => {
                for &child in &node.children {
                    let child = self.child(child);
                    self.eval(child, scoped(child, region))?;
                }
                Ok(())
            }
            Operator::Or => {
                for &child in &node.children {
                    let child = self.child(child);
                    let snapshot = self.consumptions.clone();
                    if self.eval(child, scoped(child, region)).is_ok() {
                        return Ok(());
                    }
                    self.consumptions = snapshot;
                }
                Err(Status::ParameterNotOneOfAllowed { node: id })
            }
            Operator::Empty => {
                if self.context.calldata.is_empty() {
                    Ok(())
                } else {
                    Err(Status::NotEmpty { node: id })
                }
            }
            Operator::Matches => {
                let fields = match &node.layout {
                    Layout::Tuple(fields) | Layout::AbiEncoded(fields, _) => fields,
                    _ => return Err(Status::ConditionsInvalid),
                };
                let regions = abi::tuple_fields(present(region)?, fields)?;
                let mut regions = regions.into_iter();
                for &child in &node.children {
                    let child = self.child(child);
                    let child_region = if child.layout.is_structural() {
                        Some(regions.next().ok_or(Status::ConditionsInvalid)?)
                    } else {
                        None
                    };
                    self.eval(child, child_region)?;
                }
                Ok(())
            }
            Operator::ArraySome | Operator::ArrayEvery => {
                let Layout::Array(element) = &node.layout else {
                    return Err(Status::ConditionsInvalid);
                };
                let elements = abi::array_elements(present(region)?, element)?;
                let child = self.child(node.children[0]);
                if node.operator == Operator::ArrayEvery {
                    for element in elements {
                        self.eval(child, Some(element))
                            .map_err(|_| Status::NotEveryArrayElementPasses { node: id })?;
                    }
                    return Ok(());
                }
                for element in elements {
                    let snapshot = self.consumptions.clone();
                    if self.eval(child, Some(element)).is_ok() {
                        return Ok(());
                    }
                    self.consumptions = snapshot;
                }
                Err(Status::NoArrayElementPasses { node: id })
            }
            Operator::EqualToAvatar => {
                let avatar = abi::address_word(&self.context.avatar);
                if *abi::word(present(region)?, 0)? == avatar {
                    Ok(())
                } else {
                    Err(Status::ParameterNotAllowed { node: id })
                }
            }
            Operator::EqualTo => {
                let expected = node.comp_value.as_slice();
                let actual: Word = match node.encoding {
                    Encoding::Static => *abi::word(present(region)?, 0)?,
                    Encoding::EtherValue => abi::u128_word(self.context.value),
                    Encoding::Dynamic => keccak(abi::dynamic_bytes(present(region)?)?),
                    Encoding::Tuple => {
                        let size = node.layout.head_size();
                        keccak(
                            present(region)?
                                .get(..size)
                                .ok_or(Status::CalldataOutOfBounds)?,
                        )
                    }
                    _ => return Err(Status::ConditionsInvalid),
                };
                if actual.as_slice() == expected {
                    Ok(())
                } else {
                    Err(Status::ParameterNotAllowed { node: id })
                }
            }
            Operator::GreaterThan
            | Operator::LessThan
            | Operator::SignedIntGreaterThan
            | Operator::SignedIntLessThan => {
                let mut actual = self.scalar(node, region)?;
                let mut bound: Word = node
                    .comp_value
                    .as_slice()
                    .try_into()
                    .map_err(|_| Status::ConditionsInvalid)?;
                if matches!(
                    node.operator,
                    Operator::SignedIntGreaterThan | Operator::SignedIntLessThan
                ) {
                    // Two's complement order = unsigned order with the sign bit flipped.
                    actual[0] ^= 0x80;
                    bound[0] ^= 0x80;
                }
                match node.operator {
                    Operator::GreaterThan | Operator::SignedIntGreaterThan if actual <= bound => {
                        Err(Status::ParameterLessThanAllowed { node: id })
                    }
                    Operator::LessThan | Operator::SignedIntLessThan if actual >= bound => {
                        Err(Status::ParameterGreaterThanAllowed { node: id })
                    }
                    _ => Ok(()),
                }
            }
            Operator::Bitmask => {
                let data: &[u8] = match node.encoding {
                    Encoding::Static => abi::word(present(region)?, 0)?,
                    Encoding::Dynamic => abi::dynamic_bytes(present(region)?)?,
                    _ => return Err(Status::ConditionsInvalid),
                };
                let comp = node.comp_value.as_slice();
                let offset = usize::from(u16::from_be_bytes([comp[0], comp[1]]));
                let (mask, expected) = (&comp[2..17], &comp[17..32]);
                let bytes = data
                    .get(offset..offset + 15)
                    .ok_or(Status::BitmaskNotAllowed { node: id })?;
                let passes = bytes
                    .iter()
                    .zip(mask)
                    .zip(expected)
                    .all(|((byte, mask), expected)| byte & mask == *expected);
                if passes {
                    Ok(())
                } else {
                    Err(Status::BitmaskNotAllowed { node: id })
                }
            }
            Operator::WithinAllowance => {
                let amount = self.scalar(node, region)?;
                let key = allowance_key(node)?;
                // An amount above u128 can never fit an allowance.
                let amount = abi::word_u128(&amount).ok_or_else(|| Status::AllowanceExceeded {
                    node: id,
                    key: hex_key(&key),
                })?;
                self.consume(id, key, amount, false)
            }
            Operator::CallWithinAllowance => {
                let key = allowance_key(node)?;
                self.consume(id, key, 1, true)
            }
            _ => Err(Status::ConditionsInvalid),
        }
    }

    /// The 32-byte value a comparison reads: a static parameter or the native value.
    fn scalar(&self, node: &Node, region: Option<&[u8]>) -> Result<Word, Status> {
        match node.encoding {
            Encoding::Static => Ok(*abi::word(present(region)?, 0)?),
            Encoding::EtherValue => Ok(abi::u128_word(self.context.value)),
            _ => Err(Status::ConditionsInvalid),
        }
    }

    fn consume(
        &mut self,
        node: u16,
        key: [u8; 32],
        amount: u128,
        calls: bool,
    ) -> Result<(), Status> {
        let position = match self.consumptions.iter().position(|entry| entry.key == key) {
            Some(position) => position,
            None => {
                let allowance = self.context.allowances.allowance(&key).ok_or_else(|| {
                    Status::UnknownAllowance {
                        node,
                        key: hex_key(&key),
                    }
                })?;
                let (balance, timestamp) = allowance.accrued(self.context.now);
                self.consumptions.push(Consumption {
                    key: key.to_vec(),
                    balance,
                    timestamp,
                    consumed: 0,
                    calls_only: calls,
                });
                self.consumptions.len() - 1
            }
        };
        let entry = &mut self.consumptions[position];
        entry.calls_only &= calls;
        match entry.consumed.checked_add(amount) {
            Some(total) if total <= entry.balance => {
                entry.consumed = total;
                Ok(())
            }
            _ => Err(Status::AllowanceExceeded {
                node,
                key: hex_key(&key),
            }),
        }
    }
}

/// Children that decode data share the parent's region; the others read none.
fn scoped<'a>(child: &Node, region: Option<&'a [u8]>) -> Option<&'a [u8]> {
    if child.layout.is_structural() {
        region
    } else {
        None
    }
}

fn present(region: Option<&[u8]>) -> Result<&[u8], Status> {
    region.ok_or(Status::ConditionsInvalid)
}

fn keccak(data: &[u8]) -> Word {
    Keccak256::digest(data).into()
}

fn allowance_key(node: &Node) -> Result<[u8; 32], Status> {
    node.comp_value
        .as_slice()
        .try_into()
        .map_err(|_| Status::ConditionsInvalid)
}

fn hex_key(key: &[u8; 32]) -> String {
    format!("0x{}", hex::encode(key))
}

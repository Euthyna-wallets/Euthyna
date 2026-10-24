//! Condition tree: unflattening and integrity checks.
//!
//! A tree is accepted only if every node uses an operator/encoding pair that
//! this engine evaluates. Operators of the Roles v3 format that are not yet
//! implemented are rejected with [`IntegrityError::Unsupported`] instead of
//! being silently ignored, so a permission is never weaker than it reads.

use crate::types::{ConditionFlat, Encoding, Operator};

/// Upper bound on nodes per tree (gas and storage protection).
pub const MAX_NODES: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IntegrityError {
    Empty,
    TooManyNodes,
    RootParent,
    ParentOrder { node: u16 },
    Unsupported { node: u16, operator: Operator },
    EncodingMismatch { node: u16 },
    CompValueLength { node: u16 },
    ChildrenCount { node: u16 },
    UnexpectedChildren { node: u16 },
    NonStructuralChild { node: u16 },
    BranchLayoutMismatch { node: u16 },
    RootEncoding,
}

/// Shape of the data a node decodes, used to locate values in ABI data.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Layout {
    /// Non-structural (ether value, call counters): occupies no calldata slot.
    None,
    Static,
    Dynamic,
    Array(Box<Layout>),
    Tuple(Vec<Layout>),
    /// ABI data after `leading` bytes (default 4: a function selector). At the
    /// root it is the calldata itself; nested, the content of a `bytes` value.
    AbiEncoded(Vec<Layout>, usize),
}

impl Layout {
    pub fn is_structural(&self) -> bool {
        !matches!(self, Layout::None)
    }

    pub fn is_dynamic(&self) -> bool {
        match self {
            Layout::None | Layout::Static => false,
            Layout::Dynamic | Layout::Array(_) | Layout::AbiEncoded(..) => true,
            Layout::Tuple(fields) => fields.iter().any(Layout::is_dynamic),
        }
    }

    /// Bytes occupied in the head of the enclosing tuple.
    pub fn head_size(&self) -> usize {
        match self {
            Layout::None => 0,
            Layout::Tuple(fields) if !self.is_dynamic() => {
                fields.iter().map(Layout::head_size).sum()
            }
            _ => 32,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Node {
    pub index: u16,
    pub encoding: Encoding,
    pub operator: Operator,
    pub comp_value: Vec<u8>,
    pub children: Vec<usize>,
    pub layout: Layout,
}

#[derive(Clone, Debug)]
pub struct Tree {
    pub nodes: Vec<Node>,
}

impl Tree {
    pub fn root(&self) -> &Node {
        &self.nodes[0]
    }

    pub fn node(&self, index: usize) -> &Node {
        &self.nodes[index]
    }

    /// Unflatten and validate a condition tree.
    pub fn build(flat: &[ConditionFlat]) -> Result<Self, IntegrityError> {
        if flat.is_empty() {
            return Err(IntegrityError::Empty);
        }
        if flat.len() > MAX_NODES {
            return Err(IntegrityError::TooManyNodes);
        }
        if flat[0].parent != 0 {
            return Err(IntegrityError::RootParent);
        }
        let mut nodes: Vec<Node> = flat
            .iter()
            .enumerate()
            .map(|(index, condition)| Node {
                index: index as u16,
                encoding: condition.param_type,
                operator: condition.operator,
                comp_value: condition.comp_value.clone(),
                children: Vec::new(),
                layout: Layout::None,
            })
            .collect();
        let mut previous_parent = 0u16;
        for (index, condition) in flat.iter().enumerate().skip(1) {
            let parent = condition.parent;
            if usize::from(parent) >= index || parent < previous_parent {
                return Err(IntegrityError::ParentOrder { node: index as u16 });
            }
            previous_parent = parent;
            nodes[usize::from(parent)].children.push(index);
        }
        for index in 0..nodes.len() {
            check_node(&nodes, index)?;
        }
        // Layouts bottom-up: children always have a larger index than their parent.
        for index in (0..nodes.len()).rev() {
            let layout = layout_of(&nodes, index)?;
            nodes[index].layout = layout;
        }
        for node in &nodes {
            // EqualTo on a tuple hashes its inline encoding: static tuples only.
            // On an array, it hashes `length || elements`: static elements only.
            let dynamic_content = match &node.layout {
                Layout::Array(element) => element.is_dynamic(),
                layout => layout.is_dynamic(),
            };
            if node.operator == Operator::EqualTo
                && matches!(node.encoding, Encoding::Tuple | Encoding::Array)
                && dynamic_content
            {
                return Err(IntegrityError::Unsupported {
                    node: node.index,
                    operator: node.operator,
                });
            }
        }
        let tree = Tree { nodes };
        check_root(&tree)?;
        Ok(tree)
    }
}

/// Validate a flattened tree without keeping it.
pub fn validate(flat: &[ConditionFlat]) -> Result<(), IntegrityError> {
    Tree::build(flat).map(|_| ())
}

fn check_node(nodes: &[Node], index: usize) -> Result<(), IntegrityError> {
    let node = &nodes[index];
    let id = node.index;
    let children = node.children.len();
    let comp_len = node.comp_value.len();
    let no_children = || {
        if children == 0 {
            Ok(())
        } else {
            Err(IntegrityError::UnexpectedChildren { node: id })
        }
    };
    let comp_32 = || {
        if comp_len == 32 {
            Ok(())
        } else {
            Err(IntegrityError::CompValueLength { node: id })
        }
    };
    let comp_empty = || {
        if comp_len == 0 {
            Ok(())
        } else {
            Err(IntegrityError::CompValueLength { node: id })
        }
    };
    let encoding_in = |allowed: &[Encoding]| {
        if allowed.contains(&node.encoding) {
            Ok(())
        } else {
            Err(IntegrityError::EncodingMismatch { node: id })
        }
    };
    use Encoding as E;
    match node.operator {
        Operator::Pass => {
            encoding_in(&[E::Static, E::Dynamic, E::Tuple, E::Array, E::AbiEncoded])?;
            comp_empty()?;
            structure_children(nodes, node)
        }
        Operator::And | Operator::Or => {
            encoding_in(&[E::None])?;
            comp_empty()?;
            if children == 0 {
                return Err(IntegrityError::ChildrenCount { node: id });
            }
            Ok(())
        }
        Operator::Empty => {
            encoding_in(&[E::None])?;
            comp_empty()?;
            no_children()
        }
        Operator::Matches => {
            encoding_in(&[E::Tuple, E::AbiEncoded])?;
            if node.encoding == E::Tuple {
                comp_empty()?;
            } else if comp_len != 0 && comp_len != 2 {
                return Err(IntegrityError::CompValueLength { node: id });
            }
            if children == 0 {
                return Err(IntegrityError::ChildrenCount { node: id });
            }
            Ok(())
        }
        Operator::ArraySome | Operator::ArrayEvery => {
            encoding_in(&[E::Array])?;
            comp_empty()?;
            if children != 1 {
                return Err(IntegrityError::ChildrenCount { node: id });
            }
            Ok(())
        }
        Operator::EqualToAvatar => {
            encoding_in(&[E::Static])?;
            comp_empty()?;
            no_children()
        }
        Operator::EqualTo => {
            encoding_in(&[E::Static, E::Dynamic, E::Tuple, E::Array, E::EtherValue])?;
            comp_32()?;
            if matches!(node.encoding, E::Tuple | E::Array) {
                structure_children(nodes, node)
            } else {
                no_children()
            }
        }
        Operator::GreaterThan
        | Operator::LessThan
        | Operator::SignedIntGreaterThan
        | Operator::SignedIntLessThan
        | Operator::WithinAllowance => {
            encoding_in(&[E::Static, E::EtherValue])?;
            comp_32()?;
            no_children()
        }
        Operator::Bitmask => {
            encoding_in(&[E::Static, E::Dynamic])?;
            comp_32()?;
            no_children()
        }
        Operator::CallWithinAllowance => {
            encoding_in(&[E::None])?;
            comp_32()?;
            no_children()
        }
        Operator::ArrayTailMatches
        | Operator::ZipSome
        | Operator::ZipEvery
        | Operator::Slice
        | Operator::Pluck
        | Operator::Custom
        | Operator::WithinRatio => Err(IntegrityError::Unsupported {
            node: id,
            operator: node.operator,
        }),
    }
}

/// Children of a `Pass` (or structural `EqualTo`) node may only describe structure.
fn structure_children(nodes: &[Node], node: &Node) -> Result<(), IntegrityError> {
    match node.encoding {
        Encoding::Tuple | Encoding::AbiEncoded => {
            if node.children.is_empty() {
                return Err(IntegrityError::ChildrenCount { node: node.index });
            }
        }
        Encoding::Array => {
            if node.children.len() != 1 {
                return Err(IntegrityError::ChildrenCount { node: node.index });
            }
        }
        _ => {
            if !node.children.is_empty() {
                return Err(IntegrityError::UnexpectedChildren { node: node.index });
            }
        }
    }
    for &child in &node.children {
        if nodes[child].operator != Operator::Pass {
            return Err(IntegrityError::UnexpectedChildren {
                node: nodes[child].index,
            });
        }
    }
    Ok(())
}

fn layout_of(nodes: &[Node], index: usize) -> Result<Layout, IntegrityError> {
    let node = &nodes[index];
    let id = node.index;
    let structural: Vec<&Layout> = node
        .children
        .iter()
        .map(|&child| &nodes[child].layout)
        .filter(|layout| layout.is_structural())
        .collect();
    Ok(match node.encoding {
        Encoding::EtherValue => Layout::None,
        Encoding::None => {
            let Some(first) = structural.first() else {
                return Ok(Layout::None);
            };
            if structural.iter().any(|layout| layout != first) {
                return Err(IntegrityError::BranchLayoutMismatch { node: id });
            }
            (*first).clone()
        }
        Encoding::Static => Layout::Static,
        Encoding::Dynamic => Layout::Dynamic,
        Encoding::Array => {
            let element = structural
                .first()
                .ok_or(IntegrityError::NonStructuralChild { node: id })?;
            Layout::Array(Box::new((*element).clone()))
        }
        Encoding::Tuple => {
            if structural.is_empty() {
                return Err(IntegrityError::NonStructuralChild { node: id });
            }
            Layout::Tuple(structural.into_iter().cloned().collect())
        }
        Encoding::AbiEncoded => {
            let leading = match node.comp_value.as_slice() {
                // Default: skip a 4-byte function selector.
                [] => 4,
                [high, low] => usize::from(u16::from_be_bytes([*high, *low])),
                _ => return Err(IntegrityError::CompValueLength { node: id }),
            };
            Layout::AbiEncoded(structural.into_iter().cloned().collect(), leading)
        }
    })
}

/// The root addresses the whole calldata: it must decode it as ABI data, or be
/// a logical / non-structural node.
fn check_root(tree: &Tree) -> Result<(), IntegrityError> {
    match &tree.root().layout {
        Layout::None | Layout::AbiEncoded(..) => Ok(()),
        _ => Err(IntegrityError::RootEncoding),
    }
}

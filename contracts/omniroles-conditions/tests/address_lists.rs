use omniroles_conditions::*;
use std::collections::BTreeMap;
fn node(
    parent: u16,
    param_type: Encoding,
    operator: Operator,
    comp_value: Vec<u8>,
) -> ConditionFlat {
    ConditionFlat {
        parent,
        param_type,
        operator,
        comp_value,
    }
}
fn tree() -> Vec<ConditionFlat> {
    vec![
        node(0, Encoding::AbiEncoded, Operator::Matches, vec![]),
        node(
            0,
            Encoding::Static,
            Operator::InAddressList,
            b"suppliers".to_vec(),
        ),
    ]
}
#[test]
fn list_validation() {
    let good = tree();
    assert!(validate(&good).is_ok());
    for name in [vec![], vec![b'x'; 33]] {
        let mut bad = good.clone();
        bad[1].comp_value = name;
        assert!(validate(&bad).is_err());
    }
    for encoding in [Encoding::Dynamic, Encoding::Tuple, Encoding::Array] {
        let mut bad = good.clone();
        bad[1].param_type = encoding;
        assert!(validate(&bad).is_err());
    }
    let mut bad = good.clone();
    bad.push(node(1, Encoding::Static, Operator::Pass, vec![]));
    assert!(validate(&bad).is_err());
}
#[test]
fn list_evaluation() {
    let address = [0x42; 20];
    let lists = BTreeMap::from([(b"suppliers".to_vec(), vec![address])]);
    let mut data = vec![0; 36];
    data[16..36].copy_from_slice(&address);
    let conditions = tree();
    let run = |data: &[u8]| {
        evaluate(
            &conditions,
            &Context {
                calldata: data,
                value: 0,
                avatar: [0; 20],
                now: 0,
                allowances: &BTreeMap::<[u8; 32], Allowance>::new(),
                address_lists: &lists,
            },
        )
    };
    assert!(run(&data).is_ok());
    data[35] = 0;
    assert!(matches!(
        run(&data),
        Err(Status::ParameterNotAllowed { node: 1 })
    ));
    data[35] = 0x42;
    data[4] = 1;
    assert!(matches!(
        run(&data),
        Err(Status::ParameterNotAllowed { node: 1 })
    ));
}

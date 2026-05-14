use defuse_deadline::Deadline;
use near_sdk::borsh::to_vec;

#[test]
fn test_borsh_matches_expected() {
    // Test that Deadline borsh-encodes as u32 seconds
    let deadline = Deadline::new(chrono::DateTime::from_timestamp(1778796438, 0).unwrap());
    let bytes = to_vec(&deadline).unwrap();
    
    // Should be 4 bytes: u32 LE representation of 1778796438
    println!("Deadline borsh bytes: {:02x?}", bytes);
    assert_eq!(bytes.len(), 4, "Deadline should borsh-encode to 4 bytes");
    
    // Verify the value
    let expected = 1778796438u32;
    let expected_bytes = expected.to_le_bytes();
    assert_eq!(bytes, expected_bytes, "Deadline should borsh-encode as u32 seconds");
}

#[test]
fn test_duration_borsh() {
    use std::time::Duration;
    
    let timeout = Duration::from_secs(300);
    let bytes = to_vec(&timeout).unwrap();
    
    println!("Duration borsh bytes: {:02x?}", bytes);
    assert_eq!(bytes.len(), 4, "Duration should borsh-encode to 4 bytes");
    
    let expected = 300u32;
    let expected_bytes = expected.to_le_bytes();
    // Note: Duration might not borsh-encode directly as u32 - need to check
}
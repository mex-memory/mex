//! This is a sample Rust file for testing the code-graph extractor.

use std::collections::HashMap;

/// A simple user struct
pub struct User {
    pub name: String,
    pub age: u32,
}

pub enum Role {
    Admin,
    Member,
}

pub trait Greeter {
    fn greet(&self) -> String;
}

impl Greeter for User {
    fn greet(&self) -> String {
        format!("Hello, my name is {}", self.name)
    }
}

pub const MAX_AGE: u32 = 120;
static GLOBAL_FLAG: bool = true;

pub mod admin {
    use super::*;
    
    pub fn is_admin(role: &Role) -> bool {
        match role {
            Role::Admin => true,
            _ => false,
        }
    }
}

pub fn create_user(name: String) -> User {
    let mut map = HashMap::new();
    map.insert(name.clone(), 1);
    
    admin::is_admin(&Role::Member);

    User {
        name,
        age: 30,
    }
}

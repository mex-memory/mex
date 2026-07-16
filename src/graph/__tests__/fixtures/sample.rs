//! This is a sample Rust file for testing the code-graph extractor.

use std::collections::HashMap;

// 4. Declaration-order bug test
// impl before struct
impl Order {
    pub fn process(&self) {}
}

pub struct Order {
    pub id: u32,
}

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
    // 1. Trait methods test (no body)
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

// 3. Generic type parameters tests
pub fn make<T>() -> T {
    unimplemented!()
}

pub struct Box<T> {
    pub val: T,
}

pub trait Repo<T> {
    fn get(&self) -> T;
}

pub enum Result<T, E> {
    Ok(T),
    Err(E),
}

pub fn consume<T>(val: T) {}

pub fn create_user(name: String) -> User {
    let mut map = HashMap::new();
    map.insert(name.clone(), 1);
    
    admin::is_admin(&Role::Member);

    // 5. Duplicate call edges test
    // should only emit exactly ONE call to `make` and ONE call to `consume`
    consume(make::<i32>());

    // 2. Struct instantiation test
    // should emit exactly one `instantiates` to `User`
    User {
        name,
        age: 30,
    }
}
